const socket = io();
let participantNumber = null;
let mode = 'draw'; // 'draw', 'text', 'erase'
let isDrawing = false;
let canvas, ctx;
let scale = 1;
let panX = 0;
let panY = 0;
let lastPanX = 0;
let lastPanY = 0;
let isPanning = false;
let spaceKeyPressed = false;
let canvasData = [];
let drawingPaths = new Map(); // pathId -> path data
let selectedVotes = new Set();
let availableParticipants = [];
let selectedForSection = new Set();
let currentPrivateSection = null;
let currentPathId = null;

// Initialize canvas
function initCanvas() {
    canvas = document.getElementById('canvas');
    if (!canvas) {
        console.error('Canvas element not found!');
        return;
    }
    ctx = canvas.getContext('2d');
    
    // Set initial canvas style
    canvas.style.display = 'block';
    canvas.style.cursor = 'crosshair';
    
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Drawing events
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
    
    // Touch events
    canvas.addEventListener('touchstart', handleTouchStart);
    canvas.addEventListener('touchmove', handleTouchMove);
    canvas.addEventListener('touchend', handleTouchEnd);
    
    // Zoom with mouse wheel
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    
    // Pan with middle mouse button or space + drag
    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && spaceKeyPressed)) {
            isPanning = true;
            lastPanX = e.clientX;
            lastPanY = e.clientY;
            e.preventDefault();
        }
    });
    
    canvas.addEventListener('mousemove', (e) => {
        if (isPanning) {
            panX += (e.clientX - lastPanX) / scale;
            panY += (e.clientY - lastPanY) / scale;
            lastPanX = e.clientX;
            lastPanY = e.clientY;
            redrawCanvas();
            e.preventDefault();
        }
    });
    
    canvas.addEventListener('mouseup', () => {
        isPanning = false;
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            spaceKeyPressed = true;
            e.preventDefault();
        }
    });
    
    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            spaceKeyPressed = false;
        }
    });
}

function resizeCanvas() {
    const container = document.getElementById('canvasContainer');
    if (!container || !canvas) return;
    
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight - 60; // Subtract top bar height
    
    canvas.width = width;
    canvas.height = height;
    
    // Set canvas display size
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    
    redrawCanvas();
}

function getCanvasCoordinates(e) {
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = ((e.clientX - rect.left) * scaleX - panX * scale) / scale;
    const y = ((e.clientY - rect.top) * scaleY - panY * scale) / scale;
    return { x, y };
}

function handleMouseDown(e) {
    if (!canvas || !ctx) return;
    if (e.button !== 0 && mode !== 'erase') return; // Only left click for draw/text
    
    // Prevent default for middle mouse button (pan)
    if (e.button === 1) {
        e.preventDefault();
        return;
    }
    
    const coords = getCanvasCoordinates(e);
    
    if (mode === 'draw') {
        isDrawing = true;
        currentPathId = `${socket.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        drawingPaths.set(currentPathId, {
            points: [{ x: coords.x, y: coords.y }],
            participantNumber: participantNumber
        });
        
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(panX, panY);
        ctx.beginPath();
        ctx.moveTo(coords.x, coords.y);
        ctx.restore();
        
        socket.emit('canvasAction', {
            type: 'draw',
            pathId: currentPathId,
            x: coords.x,
            y: coords.y,
            action: 'start'
        });
    } else if (mode === 'text') {
        showTextInput(coords.x, coords.y);
    } else if (mode === 'erase') {
        eraseAt(coords.x, coords.y);
    }
}

function handleMouseMove(e) {
    if (!canvas || !ctx) return;
    
    if (mode === 'draw' && isDrawing && currentPathId) {
        const coords = getCanvasCoordinates(e);
        const path = drawingPaths.get(currentPathId);
        if (path) {
            path.points.push({ x: coords.x, y: coords.y });
        }
        
        ctx.save();
        ctx.scale(scale, scale);
        ctx.translate(panX, panY);
        ctx.lineTo(coords.x, coords.y);
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 2 / scale; // Adjust line width for zoom
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.restore();
        
        // Send to server
        socket.emit('canvasAction', {
            type: 'draw',
            pathId: currentPathId,
            x: coords.x,
            y: coords.y,
            action: 'move'
        });
    }
}

function handleMouseUp(e) {
    if (mode === 'draw' && isDrawing && currentPathId) {
        isDrawing = false;
        const coords = getCanvasCoordinates(e);
        const path = drawingPaths.get(currentPathId);
        if (path) {
            path.points.push({ x: coords.x, y: coords.y });
        }
        
        socket.emit('canvasAction', {
            type: 'draw',
            pathId: currentPathId,
            x: coords.x,
            y: coords.y,
            action: 'end'
        });
        
        currentPathId = null;
    }
}

function handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousedown', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
}

function handleTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    const mouseEvent = new MouseEvent('mousemove', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    canvas.dispatchEvent(mouseEvent);
}

function handleTouchEnd(e) {
    e.preventDefault();
    const mouseEvent = new MouseEvent('mouseup', {});
    canvas.dispatchEvent(mouseEvent);
}

function handleWheel(e) {
    if (!canvas) return;
    e.preventDefault();
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Get canvas coordinates before zoom
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const worldX = (mouseX * scaleX - panX * scale) / scale;
    const worldY = (mouseY * scaleY - panY * scale) / scale;
    
    // Zoom
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    scale *= zoomFactor;
    scale = Math.max(0.1, Math.min(5, scale));
    
    // Adjust pan to zoom towards mouse position
    panX = (mouseX * scaleX) / scale - worldX;
    panY = (mouseY * scaleY) / scale - worldY;
    
    redrawCanvas();
}

function showTextInput(x, y) {
    if (!canvas) return;
    const overlay = document.getElementById('textInputOverlay');
    const input = document.getElementById('textInput');
    
    if (!overlay || !input) return;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    // Convert canvas coordinates to screen coordinates
    const screenX = (x * scale + panX * scale) * (rect.width / canvas.width) + rect.left;
    const screenY = (y * scale + panY * scale) * (rect.height / canvas.height) + rect.top;
    
    overlay.style.display = 'block';
    overlay.style.left = screenX + 'px';
    overlay.style.top = screenY + 'px';
    
    input.value = '';
    input.focus();
    
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitText(x, y, input.value);
            overlay.style.display = 'none';
        } else if (e.key === 'Escape') {
            overlay.style.display = 'none';
        }
    };
}

function submitText(x, y, text) {
    if (!text.trim()) return;
    
    socket.emit('canvasAction', {
        type: 'text',
        x,
        y,
        text,
        fontSize: 16
    });
}

function eraseAt(x, y) {
    socket.emit('erase', { x, y });
}

function redrawCanvas() {
    if (!canvas || !ctx) return;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(panX, panY);
    
    // Draw all canvas elements
    canvasData.forEach(item => {
        if (item.type === 'draw' && item.pathId) {
            // Try to get from drawingPaths first, then from item.pathPoints
            let points = null;
            const path = drawingPaths.get(item.pathId);
            if (path && path.points.length > 0) {
                points = path.points;
            } else if (item.pathPoints && item.pathPoints.length > 0) {
                points = item.pathPoints;
            }
            
            if (points && points.length > 0) {
                ctx.beginPath();
                ctx.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(points[i].x, points[i].y);
                }
                ctx.strokeStyle = '#e0e0e0';
                ctx.lineWidth = 2 / scale; // Adjust for zoom
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke();
            }
        } else if (item.type === 'text') {
            ctx.fillStyle = '#e0e0e0';
            ctx.font = `${(item.fontSize || 16) / scale}px sans-serif`; // Adjust font size for zoom
            ctx.fillText(item.text, item.x, item.y);
        }
    });
    
    ctx.restore();
}

// Socket event handlers
socket.on('joined', (data) => {
    participantNumber = data.number;
    canvasData = data.canvasData || [];
    
    // Initialize drawing paths from existing canvas data
    canvasData.forEach(item => {
        if (item.type === 'draw' && item.pathId && item.pathPoints) {
            drawingPaths.set(item.pathId, {
                points: item.pathPoints,
                participantNumber: item.participantNumber
            });
        }
    });
    
    document.getElementById('participantNumber').textContent = data.number;
    document.getElementById('joinModal').classList.remove('show');
    document.getElementById('mainInterface').style.display = 'flex';
    
    // Ensure canvas is initialized and visible
    if (!canvas) {
        initCanvas();
    }
    
    // Resize canvas to fit container
    setTimeout(() => {
        resizeCanvas();
        redrawCanvas();
    }, 100);
    
    updateParticipantCount(data.roomState.participants.length);
    
    // Set room start time if room is active
    if (data.roomState.roomActive && data.roomState.timeElapsed) {
        roomStartTime = Date.now() - data.roomState.timeElapsed;
    } else if (data.roomState.roomActive) {
        roomStartTime = Date.now();
    }
    
    redrawCanvas();
});

socket.on('joinFailed', (data) => {
    if (data.reason === 'age_verification_failed') {
        alert('You must be 18 or older to join.');
        window.location.reload();
    } else {
        alert('Unable to join: Room is full or has already started.');
        window.location.reload();
    }
});

socket.on('canvasUpdate', (action) => {
    // Only add to canvasData if it's a new item or text
    if (action.type === 'text' || (action.type === 'draw' && action.action === 'start')) {
        canvasData.push(action);
    }
    
    if (action.type === 'draw' && action.pathId) {
        if (!drawingPaths.has(action.pathId)) {
            drawingPaths.set(action.pathId, {
                points: [],
                participantNumber: action.participantNumber
            });
            // Add to canvasData for persistence
            canvasData.push({
                ...action,
                pathPoints: []
            });
        }
        const path = drawingPaths.get(action.pathId);
        if (action.action === 'start' || action.action === 'move') {
            path.points.push({ x: action.x, y: action.y });
            // Update in canvasData too
            const canvasItem = canvasData.find(item => item.pathId === action.pathId);
            if (canvasItem) {
                if (!canvasItem.pathPoints) canvasItem.pathPoints = [];
                canvasItem.pathPoints.push({ x: action.x, y: action.y });
            }
        }
        redrawCanvas();
    } else if (action.type === 'text') {
        redrawCanvas();
    }
});

socket.on('canvasErase', (data) => {
    canvasData = canvasData.filter(item => {
        if (item.x >= data.x - 10 && item.x <= data.x + 10 &&
            item.y >= data.y - 10 && item.y <= data.y + 10) {
            return false;
        }
        return true;
    });
    redrawCanvas();
});

socket.on('participantJoined', (data) => {
    updateParticipantCount();
});

socket.on('participantLeft', (data) => {
    updateParticipantCount();
});

socket.on('votingStarted', (data) => {
    showVotingModal(data.round);
});

socket.on('votingEnded', (data) => {
    hideVotingModal();
    if (data.removed && data.removed.length > 0) {
        alert(`Participants ${data.removed.join(', ')} were removed.`);
    }
});

socket.on('votingComplete', (data) => {
    showVotingCompleteModal(data.remaining);
    document.getElementById('createSectionBtn').style.display = 'block';
});

socket.on('removed', (data) => {
    alert('You have been removed from the room.');
    window.location.reload();
});

socket.on('roomClosed', () => {
    document.getElementById('roomClosedModal').classList.add('show');
});

socket.on('privateSectionCreated', (data) => {
    currentPrivateSection = data.sectionId;
    alert(`Private section created with participants: ${data.members.join(', ')}`);
});

// Age verification
document.getElementById('ageYes').addEventListener('click', () => {
    document.getElementById('ageModal').classList.remove('show');
    document.getElementById('joinModal').classList.add('show');
    socket.emit('join', { ageVerified: true });
});

document.getElementById('ageNo').addEventListener('click', () => {
    alert('You must be 18 or older to access this platform.');
    window.location.href = 'about:blank';
});

// Mode buttons
document.getElementById('drawMode').addEventListener('click', () => {
    mode = 'draw';
    canvas.className = '';
    updateModeButtons();
});

document.getElementById('textMode').addEventListener('click', () => {
    mode = 'text';
    canvas.className = 'text-mode';
    updateModeButtons();
});

document.getElementById('eraseMode').addEventListener('click', () => {
    mode = 'erase';
    canvas.className = 'erase-mode';
    updateModeButtons();
});

function updateModeButtons() {
    document.getElementById('drawMode').classList.toggle('active', mode === 'draw');
    document.getElementById('textMode').classList.toggle('active', mode === 'text');
    document.getElementById('eraseMode').classList.toggle('active', mode === 'erase');
}

// Voting modal
function showVotingModal(round) {
    document.getElementById('votingRoundNumber').textContent = round;
    selectedVotes.clear();
    
    // Get current participants
    socket.emit('getParticipants', {}, (participants) => {
        const container = document.getElementById('votingParticipants');
        container.innerHTML = '';
        
        if (participants.length === 0) {
            container.innerHTML = '<p>No other participants to vote for.</p>';
            document.getElementById('submitVote').disabled = true;
        } else {
            participants.forEach(p => {
                if (p.number === participantNumber) return; // Can't vote for self
                
                const div = document.createElement('div');
                div.className = 'voting-participant';
                div.textContent = `#${p.number}`;
                div.onclick = () => {
                    if (selectedVotes.has(p.number)) {
                        selectedVotes.delete(p.number);
                        div.classList.remove('selected');
                    } else {
                        selectedVotes.add(p.number);
                        div.classList.add('selected');
                    }
                    document.getElementById('submitVote').disabled = selectedVotes.size === 0;
                };
                container.appendChild(div);
            });
        }
    });
    
    document.getElementById('votingModal').classList.add('show');
}

function hideVotingModal() {
    document.getElementById('votingModal').classList.remove('show');
}

document.getElementById('submitVote').addEventListener('click', () => {
    socket.emit('vote', { votedNumbers: Array.from(selectedVotes) });
    hideVotingModal();
});

// Voting complete modal
function showVotingCompleteModal(remaining) {
    document.getElementById('remainingParticipants').textContent = remaining.join(', ');
    document.getElementById('votingCompleteModal').classList.add('show');
}

document.getElementById('closeVotingComplete').addEventListener('click', () => {
    document.getElementById('votingCompleteModal').classList.remove('show');
});

// Create private section
document.getElementById('createSectionBtn').addEventListener('click', () => {
    socket.emit('getAvailableParticipants', {}, (participants) => {
        availableParticipants = participants;
        showCreateSectionModal();
    });
});

function showCreateSectionModal() {
    const container = document.getElementById('availableParticipants');
    container.innerHTML = '';
    selectedForSection.clear();
    
    availableParticipants.forEach(p => {
        if (p.number === participantNumber || p.inPrivateSection) return;
        
        const div = document.createElement('div');
        div.className = 'available-participant';
        div.textContent = `#${p.number}`;
        div.onclick = () => {
            if (selectedForSection.has(p.number)) {
                selectedForSection.delete(p.number);
                div.classList.remove('selected');
            } else {
                if (selectedForSection.size >= 2) {
                    alert('Maximum 2 participants can be invited.');
                    return;
                }
                selectedForSection.add(p.number);
                div.classList.add('selected');
            }
        };
        container.appendChild(div);
    });
    
    document.getElementById('createSectionModal').classList.add('show');
}

document.getElementById('confirmSection').addEventListener('click', () => {
    socket.emit('createPrivateSection', {
        inviteeNumbers: Array.from(selectedForSection)
    }, (response) => {
        if (response.success) {
            document.getElementById('createSectionModal').classList.remove('show');
        } else {
            alert('Failed to create private section.');
        }
    });
});

document.getElementById('cancelSection').addEventListener('click', () => {
    document.getElementById('createSectionModal').classList.remove('show');
});

// Room timer
let roomStartTime = null;
function updateRoomTimer() {
    if (!roomStartTime) return;
    
    const elapsed = Date.now() - roomStartTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    
    const timerElement = document.getElementById('roomTimer');
    if (timerElement) {
        timerElement.textContent = 
            `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
}

// Update timer every second
setInterval(updateRoomTimer, 1000);

function updateParticipantCount(count) {
    if (count !== undefined) {
        document.getElementById('participantCount').textContent = count;
    } else {
        // Request from server
        socket.emit('getParticipantCount', {}, (count) => {
            document.getElementById('participantCount').textContent = count;
        });
    }
}

// Initialize canvas when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCanvas);
} else {
    // DOM already loaded
    setTimeout(initCanvas, 0);
}

