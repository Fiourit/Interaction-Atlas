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
let drawingPaths = new Map();
let selectedVotes = new Set();
let availableParticipants = [];
let selectedForSection = new Set();
let currentPrivateSection = null;
let currentPathId = null;
let lastEraseTime = 0;
const ERASE_THROTTLE = 50;
let lastTouchDistance = null;
let initialScale = 1;
let initialPanX = 0;
let initialPanY = 0;
let touchStartTime = 0;
let touchStartX = 0;
let touchStartY = 0;
let isTouchPanning = false;
let lastTouchX = 0;
let lastTouchY = 0;

// Initialize canvas
function initCanvas() {
    canvas = document.getElementById('canvas');
    if (!canvas) {
        console.error('Canvas element not found!');
        return;
    }
    ctx = canvas.getContext('2d');
    
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
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
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
        if (e.code === 'Space' && document.activeElement !== document.getElementById('textInput')) {
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
    const height = container.clientHeight || window.innerHeight - 60;
    
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    
    redrawCanvas();
}

// Convert screen coordinates to world coordinates
function getCanvasCoordinates(e) {
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    let clientX, clientY;
    
    // Handle both mouse and touch events
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    
    // Get position relative to canvas element
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    // Convert to canvas internal coordinates
    const canvasX = (x / rect.width) * canvas.width;
    const canvasY = (y / rect.height) * canvas.height;
    
    // Convert to world coordinates
    // Transform is: translate(panX, panY) then scale(scale, scale)
    // So world point (x, y) becomes ((x + panX) * scale, (y + panY) * scale) on screen
    // Inverse: screen point becomes ((screenX / scale) - panX, (screenY / scale) - panY) in world
    const worldX = (canvasX / scale) - panX;
    const worldY = (canvasY / scale) - panY;
    
    return { x: worldX, y: worldY };
}

function handleMouseDown(e) {
    if (!canvas || !ctx) return;
    if (e.button !== 0 && mode !== 'erase') return;
    
    if (e.button === 1) {
        e.preventDefault();
        return;
    }
    
    const coords = getCanvasCoordinates(e);
    
    if (mode === 'draw') {
        isDrawing = true;
        currentPathId = `${socket.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const firstPoint = { x: coords.x, y: coords.y };
        drawingPaths.set(currentPathId, {
            points: [firstPoint],
            participantNumber: participantNumber
        });
        
        canvasData.push({
            type: 'draw',
            pathId: currentPathId,
            pathPoints: [firstPoint],
            participantNumber: participantNumber
        });
        
        redrawCanvas();
        
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
        isDrawing = true;
        eraseAt(coords.x, coords.y);
    }
}

function handleMouseMove(e) {
    if (!canvas || !ctx) return;
    
    if (mode === 'draw' && isDrawing && currentPathId) {
        const coords = getCanvasCoordinates(e);
        const path = drawingPaths.get(currentPathId);
        
        if (path && path.points.length > 0) {
            const lastPoint = path.points[path.points.length - 1];
            const dx = coords.x - lastPoint.x;
            const dy = coords.y - lastPoint.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            // Only add point if moved significantly
            if (dist > 0.5) {
                const newPoint = { x: coords.x, y: coords.y };
                path.points.push(newPoint);
                
                const canvasItem = canvasData.find(item => item.pathId === currentPathId);
                if (canvasItem) {
                    if (!canvasItem.pathPoints) canvasItem.pathPoints = [];
                    canvasItem.pathPoints.push(newPoint);
                }
                
                redrawCanvas();
                
                socket.emit('canvasAction', {
                    type: 'draw',
                    pathId: currentPathId,
                    x: coords.x,
                    y: coords.y,
                    action: 'move'
                });
            }
        }
    } else if (mode === 'erase' && isDrawing) {
        const coords = getCanvasCoordinates(e);
        eraseAt(coords.x, coords.y);
    }
}

function handleMouseUp(e) {
    if (mode === 'draw' && isDrawing && currentPathId) {
        isDrawing = false;
        const coords = getCanvasCoordinates(e);
        const path = drawingPaths.get(currentPathId);
        
        if (path && path.points.length > 0) {
            const lastPoint = path.points[path.points.length - 1];
            if (Math.abs(coords.x - lastPoint.x) > 0.01 || Math.abs(coords.y - lastPoint.y) > 0.01) {
                const finalPoint = { x: coords.x, y: coords.y };
                path.points.push(finalPoint);
                
                const canvasItem = canvasData.find(item => item.pathId === currentPathId);
                if (canvasItem) {
                    if (!canvasItem.pathPoints) canvasItem.pathPoints = [];
                    canvasItem.pathPoints.push(finalPoint);
                }
            }
            
            redrawCanvas();
        }
        
        socket.emit('canvasAction', {
            type: 'draw',
            pathId: currentPathId,
            x: coords.x,
            y: coords.y,
            action: 'end'
        });
        
        currentPathId = null;
    } else if (mode === 'erase' && isDrawing) {
        isDrawing = false;
    }
}

function handleTouchStart(e) {
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        touchStartTime = Date.now();
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        lastTouchX = touch.clientX;
        lastTouchY = touch.clientY;
        
        // If in draw/erase/text mode, handle drawing directly
        if (mode === 'draw' || mode === 'erase' || mode === 'text') {
            e.preventDefault();
            // Create a synthetic event object for getCanvasCoordinates
            const syntheticEvent = {
                touches: [touch],
                clientX: touch.clientX,
                clientY: touch.clientY
            };
            const coords = getCanvasCoordinates(syntheticEvent);
            
            if (mode === 'draw') {
                isDrawing = true;
                currentPathId = `${socket.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                const firstPoint = { x: coords.x, y: coords.y };
                drawingPaths.set(currentPathId, {
                    points: [firstPoint],
                    participantNumber: participantNumber
                });
                
                canvasData.push({
                    type: 'draw',
                    pathId: currentPathId,
                    pathPoints: [firstPoint],
                    participantNumber: participantNumber
                });
                
                redrawCanvas();
                
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
                isDrawing = true;
                eraseAt(coords.x, coords.y);
            }
        } else {
            // Not in draw mode - allow panning
            isTouchPanning = true;
            e.preventDefault();
        }
    } else if (e.touches.length === 2) {
        e.preventDefault();
        isTouchPanning = false;
        isDrawing = false;
        currentPathId = null;
        
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        
        lastTouchDistance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
        );
        
        initialScale = scale;
        initialPanX = panX;
        initialPanY = panY;
        
        const rect = canvas.getBoundingClientRect();
        const centerX = (touch1.clientX + touch2.clientX) / 2 - rect.left;
        const centerY = (touch1.clientY + touch2.clientY) / 2 - rect.top;
        
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const worldX = (centerX * scaleX / scale) - panX;
        const worldY = (centerY * scaleY / scale) - panY;
        
        canvas._pinchCenter = { worldX, worldY, screenX: centerX, screenY: centerY };
    }
}

function handleTouchMove(e) {
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        
        if (mode === 'draw' && isDrawing && currentPathId) {
            e.preventDefault();
            const syntheticEvent = {
                touches: [touch],
                clientX: touch.clientX,
                clientY: touch.clientY
            };
            const coords = getCanvasCoordinates(syntheticEvent);
            const path = drawingPaths.get(currentPathId);
            
            if (path && path.points.length > 0) {
                const lastPoint = path.points[path.points.length - 1];
                const dx = coords.x - lastPoint.x;
                const dy = coords.y - lastPoint.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist > 0.5) {
                    const newPoint = { x: coords.x, y: coords.y };
                    path.points.push(newPoint);
                    
                    const canvasItem = canvasData.find(item => item.pathId === currentPathId);
                    if (canvasItem) {
                        if (!canvasItem.pathPoints) canvasItem.pathPoints = [];
                        canvasItem.pathPoints.push(newPoint);
                    }
                    
                    redrawCanvas();
                    
                    socket.emit('canvasAction', {
                        type: 'draw',
                        pathId: currentPathId,
                        x: coords.x,
                        y: coords.y,
                        action: 'move'
                    });
                }
            }
        } else if (mode === 'erase' && isDrawing) {
            e.preventDefault();
            const syntheticEvent = {
                touches: [touch],
                clientX: touch.clientX,
                clientY: touch.clientY
            };
            const coords = getCanvasCoordinates(syntheticEvent);
            eraseAt(coords.x, coords.y);
        } else if (isTouchPanning) {
            e.preventDefault();
            const dx = touch.clientX - lastTouchX;
            const dy = touch.clientY - lastTouchY;
            
            // Convert screen movement to world movement
            const rect = canvas.getBoundingClientRect();
            const worldDx = (dx / rect.width) * (canvas.width / scale);
            const worldDy = (dy / rect.height) * (canvas.height / scale);
            
            panX += worldDx;
            panY += worldDy;
            
            lastTouchX = touch.clientX;
            lastTouchY = touch.clientY;
            
            redrawCanvas();
        }
    } else if (e.touches.length === 2) {
        e.preventDefault();
        isTouchPanning = false;
        
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        
        const currentDistance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
        );
        
        if (lastTouchDistance && canvas._pinchCenter) {
            const zoomFactor = currentDistance / lastTouchDistance;
            const newScale = initialScale * zoomFactor;
            scale = Math.max(0.1, Math.min(5, newScale));
            
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            
            panX = (canvas._pinchCenter.screenX * scaleX / scale) - canvas._pinchCenter.worldX;
            panY = (canvas._pinchCenter.screenY * scaleY / scale) - canvas._pinchCenter.worldY;
            
            redrawCanvas();
        }
        
        lastTouchDistance = currentDistance;
    }
}

function handleTouchEnd(e) {
    if (mode === 'draw' && isDrawing && currentPathId) {
        const touch = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : null;
        if (touch) {
            const syntheticEvent = {
                touches: [touch],
                clientX: touch.clientX,
                clientY: touch.clientY
            };
            const coords = getCanvasCoordinates(syntheticEvent);
            const path = drawingPaths.get(currentPathId);
            
            if (path && path.points.length > 0) {
                const lastPoint = path.points[path.points.length - 1];
                if (Math.abs(coords.x - lastPoint.x) > 0.01 || Math.abs(coords.y - lastPoint.y) > 0.01) {
                    const finalPoint = { x: coords.x, y: coords.y };
                    path.points.push(finalPoint);
                    
                    const canvasItem = canvasData.find(item => item.pathId === currentPathId);
                    if (canvasItem) {
                        if (!canvasItem.pathPoints) canvasItem.pathPoints = [];
                        canvasItem.pathPoints.push(finalPoint);
                    }
                }
                
                redrawCanvas();
            }
            
            socket.emit('canvasAction', {
                type: 'draw',
                pathId: currentPathId,
                x: coords.x,
                y: coords.y,
                action: 'end'
            });
        }
        
        isDrawing = false;
        currentPathId = null;
    } else if (mode === 'erase' && isDrawing) {
        isDrawing = false;
    }
    
    isTouchPanning = false;
    
    if (e.touches.length === 0) {
        lastTouchDistance = null;
        canvas._pinchCenter = null;
    } else if (e.touches.length === 1) {
        lastTouchDistance = null;
        canvas._pinchCenter = null;
    }
}

function handleWheel(e) {
    if (!canvas) return;
    e.preventDefault();
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const worldX = (mouseX * scaleX / scale) - panX;
    const worldY = (mouseY * scaleY / scale) - panY;
    
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    scale *= zoomFactor;
    scale = Math.max(0.1, Math.min(5, scale));
    
    panX = (mouseX * scaleX / scale) - worldX;
    panY = (mouseY * scaleY / scale) - worldY;
    
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
    
    const screenX = ((x + panX) * scale) * (rect.width / canvas.width) + rect.left;
    const screenY = ((y + panY) * scale) * (rect.height / canvas.height) + rect.top;
    
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
        if (e.code === 'Space') {
            e.stopPropagation();
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
    const eraseRadius = 20;
    const itemsToErase = [];
    
    canvasData.forEach((item, index) => {
        if (item.type === 'text') {
            const distance = Math.sqrt(Math.pow(item.x - x, 2) + Math.pow(item.y - y, 2));
            if (distance < eraseRadius) {
                itemsToErase.push(index);
            }
        } else if (item.type === 'draw' && item.pathId) {
            let points = null;
            const path = drawingPaths.get(item.pathId);
            if (path && path.points.length > 0) {
                points = path.points;
            } else if (item.pathPoints && item.pathPoints.length > 0) {
                points = item.pathPoints;
            }
            
            if (points) {
                for (let i = 0; i < points.length; i++) {
                    const distance = Math.sqrt(Math.pow(points[i].x - x, 2) + Math.pow(points[i].y - y, 2));
                    if (distance < eraseRadius) {
                        itemsToErase.push(index);
                        break;
                    }
                }
            }
        }
    });
    
    itemsToErase.reverse().forEach(index => {
        const item = canvasData[index];
        if (item.pathId) {
            drawingPaths.delete(item.pathId);
        }
        canvasData.splice(index, 1);
    });
    
    if (itemsToErase.length > 0) {
        redrawCanvas();
        
        const now = Date.now();
        if (now - lastEraseTime > ERASE_THROTTLE) {
            socket.emit('erase', { x, y, eraseRadius });
            lastEraseTime = now;
        }
    }
}

function redrawCanvas() {
    if (!canvas || !ctx) return;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Apply transform: translate then scale
    // This means world point (x, y) becomes ((x + panX) * scale, (y + panY) * scale) on screen
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);
    
    // Draw all paths
    canvasData.forEach(item => {
        if (item.type === 'draw' && item.pathId) {
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
                ctx.lineWidth = 2;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke();
            }
        } else if (item.type === 'text') {
            ctx.fillStyle = '#e0e0e0';
            ctx.font = `${item.fontSize || 16}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif`;
            ctx.fillText(item.text, item.x, item.y);
        }
    });
    
    ctx.restore();
}

// Socket event handlers
socket.on('joined', (data) => {
    participantNumber = data.number;
    canvasData = data.canvasData || [];
    
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
    
    if (!canvas) {
        initCanvas();
    }
    
    setTimeout(() => {
        resizeCanvas();
        redrawCanvas();
    }, 100);
    
    updateParticipantCount(data.roomState.participants.length);
    
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
    if (action.type === 'draw' && action.pathId) {
        if (!drawingPaths.has(action.pathId)) {
            drawingPaths.set(action.pathId, {
                points: [],
                participantNumber: action.participantNumber
            });
            const existingItem = canvasData.find(item => item.pathId === action.pathId);
            if (!existingItem) {
                canvasData.push({
                    ...action,
                    pathPoints: []
                });
            }
        }
        const path = drawingPaths.get(action.pathId);
        if (action.action === 'start' || action.action === 'move') {
            path.points.push({ x: action.x, y: action.y });
            const canvasItem = canvasData.find(item => item.pathId === action.pathId);
            if (canvasItem) {
                if (!canvasItem.pathPoints) canvasItem.pathPoints = [];
                canvasItem.pathPoints.push({ x: action.x, y: action.y });
            }
        }
        redrawCanvas();
    } else if (action.type === 'text') {
        const existingText = canvasData.find(item => 
            item.type === 'text' && 
            item.x === action.x && 
            item.y === action.y && 
            item.text === action.text
        );
        if (!existingText) {
            canvasData.push(action);
        }
        redrawCanvas();
    }
});

socket.on('canvasErase', (data) => {
    const eraseRadius = data.eraseRadius || 20;
    const itemsToRemove = [];
    
    canvasData.forEach((item, index) => {
        if (item.type === 'text') {
            const distance = Math.sqrt(Math.pow(item.x - data.x, 2) + Math.pow(item.y - data.y, 2));
            if (distance < eraseRadius) {
                itemsToRemove.push(index);
            }
        } else if (item.type === 'draw' && item.pathId) {
            let points = null;
            const path = drawingPaths.get(item.pathId);
            if (path && path.points.length > 0) {
                points = path.points;
            } else if (item.pathPoints && item.pathPoints.length > 0) {
                points = item.pathPoints;
            }
            
            if (points) {
                for (let i = 0; i < points.length; i++) {
                    const distance = Math.sqrt(Math.pow(points[i].x - data.x, 2) + Math.pow(points[i].y - data.y, 2));
                    if (distance < eraseRadius) {
                        itemsToRemove.push(index);
                        break;
                    }
                }
            }
        }
    });
    
    itemsToRemove.reverse().forEach(index => {
        const item = canvasData[index];
        if (item.pathId) {
            drawingPaths.delete(item.pathId);
        }
        canvasData.splice(index, 1);
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

// Instructions button
document.getElementById('instructionsBtn').addEventListener('click', () => {
    document.getElementById('instructionsModal').classList.add('show');
});

document.getElementById('closeInstructions').addEventListener('click', () => {
    document.getElementById('instructionsModal').classList.remove('show');
});

document.getElementById('instructionsModal').addEventListener('click', (e) => {
    if (e.target.id === 'instructionsModal') {
        document.getElementById('instructionsModal').classList.remove('show');
    }
});

// About button
document.getElementById('aboutBtn').addEventListener('click', () => {
    document.getElementById('aboutModal').classList.add('show');
});

document.getElementById('closeAbout').addEventListener('click', () => {
    document.getElementById('aboutModal').classList.remove('show');
});

document.getElementById('aboutModal').addEventListener('click', (e) => {
    if (e.target.id === 'aboutModal') {
        document.getElementById('aboutModal').classList.remove('show');
    }
});

// Author info click handler
let authorInfoTimeout = null;
canvas.addEventListener('click', (e) => {
    if (mode === 'erase' || mode === 'text' || isDrawing) {
        return;
    }
    
    if (authorInfoTimeout) {
        clearTimeout(authorInfoTimeout);
    }
    
    authorInfoTimeout = setTimeout(() => {
        if (mode !== 'erase' && mode !== 'text' && !isDrawing) {
            const coords = getCanvasCoordinates(e);
            showAuthorInfo(coords.x, coords.y);
        }
    }, 100);
});

// Handle tap for author info on mobile
canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0 && mode !== 'erase' && mode !== 'text' && !isDrawing && !isTouchPanning) {
        const touch = e.changedTouches[0];
        const timeDiff = Date.now() - touchStartTime;
        const dist = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
        
        // Only treat as tap if it was quick and didn't move much
        if (timeDiff < 300 && dist < 10) {
            const syntheticEvent = {
                touches: [touch],
                clientX: touch.clientX,
                clientY: touch.clientY
            };
            const coords = getCanvasCoordinates(syntheticEvent);
            showAuthorInfo(coords.x, coords.y);
        }
    }
});

function showAuthorInfo(x, y) {
    const clickRadius = 30;
    let foundItem = null;
    
    for (const item of canvasData) {
        if (item.type === 'text') {
            const distance = Math.sqrt(Math.pow(item.x - x, 2) + Math.pow(item.y - y, 2));
            if (distance < clickRadius) {
                foundItem = item;
                break;
            }
        } else if (item.type === 'draw' && item.pathId) {
            let points = null;
            const path = drawingPaths.get(item.pathId);
            if (path && path.points.length > 0) {
                points = path.points;
            } else if (item.pathPoints && item.pathPoints.length > 0) {
                points = item.pathPoints;
            }
            
            if (points) {
                for (let i = 0; i < points.length; i++) {
                    const distance = Math.sqrt(Math.pow(points[i].x - x, 2) + Math.pow(points[i].y - y, 2));
                    if (distance < clickRadius) {
                        foundItem = item;
                        break;
                    }
                }
            }
        }
        if (foundItem) break;
    }
    
    if (foundItem && foundItem.participantNumber) {
        const authorInfo = document.getElementById('authorInfo');
        if (authorInfo) {
            authorInfo.textContent = `Author: Participant #${foundItem.participantNumber}`;
            authorInfo.style.display = 'block';
            
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            let screenX = ((x + panX) * scale) * (rect.width / canvas.width) + rect.left;
            let screenY = ((y + panY) * scale) * (rect.height / canvas.height) + rect.top;
            
            authorInfo.style.visibility = 'hidden';
            authorInfo.style.display = 'block';
            const infoWidth = authorInfo.offsetWidth || 200;
            const infoHeight = authorInfo.offsetHeight || 30;
            authorInfo.style.visibility = 'visible';
            
            const padding = 10;
            if (screenX + infoWidth > window.innerWidth - padding) {
                screenX = window.innerWidth - infoWidth - padding;
            }
            if (screenX < padding) {
                screenX = padding;
            }
            if (screenY - infoHeight < padding) {
                screenY = screenY + 40;
            }
            if (screenY + infoHeight > window.innerHeight - padding) {
                screenY = window.innerHeight - infoHeight - padding;
            }
            
            authorInfo.style.left = screenX + 'px';
            authorInfo.style.top = (screenY - infoHeight) + 'px';
            
            setTimeout(() => {
                authorInfo.style.display = 'none';
            }, 5000);
        }
    }
}

function updateModeButtons() {
    document.getElementById('drawMode').classList.toggle('active', mode === 'draw');
    document.getElementById('textMode').classList.toggle('active', mode === 'text');
    document.getElementById('eraseMode').classList.toggle('active', mode === 'erase');
}

// Voting modal
function showVotingModal(round) {
    document.getElementById('votingRoundNumber').textContent = round;
    selectedVotes.clear();
    
    socket.emit('getParticipants', {}, (participants) => {
        const container = document.getElementById('votingParticipants');
        container.innerHTML = '';
        
        if (participants.length === 0) {
            container.innerHTML = '<p>No other participants to vote for.</p>';
            document.getElementById('submitVote').disabled = true;
        } else {
            participants.forEach(p => {
                if (p.number === participantNumber) return;
                
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

setInterval(updateRoomTimer, 1000);

function updateParticipantCount(count) {
    if (count !== undefined) {
        document.getElementById('participantCount').textContent = count;
    } else {
        socket.emit('getParticipantCount', {}, (count) => {
            document.getElementById('participantCount').textContent = count;
        });
    }
}

// Initialize canvas when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCanvas);
} else {
    setTimeout(initCanvas, 0);
}
