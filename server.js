// WebSocket server for INTERACTION ATLAS
// Run with: node server.js
// Requires: npm install ws

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_PARTICIPANTS = 20;

// HTTP server
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'interaction-atlas.html');
        fs.readFile(htmlPath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

const wss = new WebSocket.Server({ server });

// SINGLE ROOM - All participants join the same room
const room = {
    participants: new Map(), // participantId -> { id, number, ws }
    drawings: [],
    texts: [],
    votes: {},
    sections: [],
    startTime: Date.now(),
    votingRound: 0,
    sessionPhase: 'open'
};

// Lock for join operations - ensures only one join happens at a time
let joinInProgress = false;
const joinQueue = [];

// Process join queue one at a time
async function processJoinQueue() {
    if (joinInProgress || joinQueue.length === 0) return;
    
    joinInProgress = true;
    
    while (joinQueue.length > 0) {
        const { ws, resolve, reject } = joinQueue.shift();
        
        try {
            // Clean up dead connections first
            cleanupDeadConnections();
            
            // Count only active participants
            const activeCount = getActiveCount();
            
            if (activeCount >= MAX_PARTICIPANTS) {
                console.log(`Room is full (${activeCount}/${MAX_PARTICIPANTS}). Rejecting join.`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Room is full (max 20 participants). Please try again later.'
                    }));
                    ws.close();
                }
                resolve(null);
                continue;
            }
            
            // Get available number (1-20)
            const participantNumber = getAvailableNumber();
            if (!participantNumber || activeCount >= MAX_PARTICIPANTS) {
                console.log(`No number available. Room has ${activeCount} active participants.`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Room is full (max 20 participants). Please try again later.'
                    }));
                    ws.close();
                }
                resolve(null);
                continue;
            }
            
            // Create unique participant ID
            const participantId = `p-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            // Add participant BEFORE checking count again
            room.participants.set(participantId, {
                id: participantId,
                number: participantNumber,
                ws: ws
            });
            
            // Store in WebSocket for easy access
            ws._participantId = participantId;
            ws._participantNumber = participantNumber;
            
            // Final verification - should never exceed 20
            const finalCount = getActiveCount();
            if (finalCount > MAX_PARTICIPANTS) {
                console.error(`ERROR: Room exceeded limit! Count: ${finalCount}, Removing participant.`);
                room.participants.delete(participantId);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Room is full (max 20 participants). Please try again later.'
                    }));
                    ws.close();
                }
                resolve(null);
                continue;
            }
            
            console.log(`Participant #${participantNumber} joined. Total active: ${finalCount}/${MAX_PARTICIPANTS}`);
            
            // Get list of active participants (excluding self for the list)
            const activeParticipants = getActiveParticipantsList();
            
            // Send join confirmation
            ws.send(JSON.stringify({
                type: 'joined',
                participantId: participantId,
                number: participantNumber,
                participants: activeParticipants,
                drawings: room.drawings,
                texts: room.texts,
                sessionPhase: room.sessionPhase,
                votingRound: room.votingRound
            }));
            
            // Notify others (but not self)
            broadcastToRoom({
                type: 'participant_joined',
                participant: {
                    id: participantId,
                    number: participantNumber
                }
            }, ws);
            
            // Start voting phases if not already started
            startVotingPhases();
            
            resolve({ participantId, participantNumber });
            
        } catch (error) {
            console.error('Error processing join:', error);
            reject(error);
        }
    }
    
    joinInProgress = false;
}

// Get active participant count
function getActiveCount() {
    let count = 0;
    room.participants.forEach(participant => {
        if (participant.ws.readyState === WebSocket.OPEN) {
            count++;
        }
    });
    return count;
}

// Clean up dead connections
function cleanupDeadConnections() {
    const toDelete = [];
    room.participants.forEach((participant, id) => {
        if (participant.ws.readyState !== WebSocket.OPEN) {
            toDelete.push(id);
        }
    });
    toDelete.forEach(id => {
        const participant = room.participants.get(id);
        room.participants.delete(id);
        delete room.votes[id];
        // Remove from sections
        room.sections.forEach(section => {
            section.members = section.members.filter(m => m.id !== id);
            if (section.members.length === 0) {
                room.sections = room.sections.filter(s => s.id !== section.id);
            }
        });
    });
}

// Get available participant number (1-20) - ensures uniqueness
function getAvailableNumber() {
    const usedNumbers = new Set();
    room.participants.forEach(participant => {
        if (participant.ws.readyState === WebSocket.OPEN) {
            usedNumbers.add(participant.number);
        }
    });
    
    // Find first available number 1-20
    for (let i = 1; i <= MAX_PARTICIPANTS; i++) {
        if (!usedNumbers.has(i)) {
            return i;
        }
    }
    return null; // All numbers taken
}

// Get list of active participants
function getActiveParticipantsList() {
    const list = [];
    room.participants.forEach(participant => {
        if (participant.ws.readyState === WebSocket.OPEN) {
            list.push({
                id: participant.id,
                number: participant.number
            });
        }
    });
    return list;
}

// Handle join request
function handleJoin(ws) {
    return new Promise((resolve, reject) => {
        joinQueue.push({ ws, resolve, reject });
        processJoinQueue();
    });
}

// Broadcast message to all participants
function broadcastToRoom(message, excludeWs = null) {
    const data = JSON.stringify(message);
    room.participants.forEach(participant => {
        if (participant.ws !== excludeWs && participant.ws.readyState === WebSocket.OPEN) {
            try {
                participant.ws.send(data);
            } catch (error) {
                console.error('Error broadcasting:', error);
            }
        }
    });
}

// Remove participant
function removeParticipant(participantId) {
    if (!room.participants.has(participantId)) return;
    
    const participant = room.participants.get(participantId);
    
    if (participant.ws.readyState === WebSocket.OPEN) {
        try {
            participant.ws.send(JSON.stringify({
                type: 'removed',
                reason: 'Voted out by participants'
            }));
            participant.ws.close();
        } catch (error) {
            console.error('Error removing participant:', error);
        }
    }
    
    room.participants.delete(participantId);
    delete room.votes[participantId];
    
    // Remove from sections
    room.sections.forEach(section => {
        section.members = section.members.filter(m => m.id !== participantId);
        if (section.members.length === 0) {
            room.sections = room.sections.filter(s => s.id !== section.id);
        }
    });
    
    broadcastToRoom({
        type: 'participant_removed',
        participantId: participantId,
        number: participant.number
    });
    
    console.log(`Participant #${participant.number} removed. Active count: ${getActiveCount()}/${MAX_PARTICIPANTS}`);
}

// Check if participant can interact
function canInteract(participantId) {
    if (room.sessionPhase === 'open') return true;
    const section = room.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return !!section;
}

// Get participant's section ID
function getParticipantSection(participantId) {
    if (room.sessionPhase === 'open') return null;
    const section = room.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return section ? section.id : null;
}

// Start voting phases
function startVotingPhases() {
    if (room.votingRound > 0) return; // Already started
    
    const elapsed = Date.now() - room.startTime;
    const scheduleVoting = (round, delay) => {
        if (delay > 0) {
            setTimeout(() => {
                room.votingRound = round;
                room.votes = {};
                broadcastToRoom({
                    type: 'voting_started',
                    round: round
                });
                
                setTimeout(() => {
                    room.votingRound = 0;
                    broadcastToRoom({ type: 'voting_ended' });
                    
                    if (round === 3) {
                        setTimeout(() => {
                            room.sessionPhase = 'sections';
                            const remainingNumbers = getActiveParticipantsList()
                                .map(p => p.number)
                                .sort((a, b) => a - b);
                            broadcastToRoom({
                                type: 'sections_phase',
                                remainingNumbers: remainingNumbers
                            });
                        }, 1000);
                    }
                }, 60000);
            }, delay);
        }
    };

    scheduleVoting(1, 20 * 60000 - elapsed);
    scheduleVoting(2, 40 * 60000 - elapsed);
    scheduleVoting(3, 60 * 60000 - elapsed);
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Get participant info from WebSocket context
            const participantId = ws._participantId;
            const participantNumber = ws._participantNumber;

            switch (data.type) {
                case 'join':
                    // Prevent duplicate joins
                    if (participantId) {
                        console.log('Duplicate join attempt ignored');
                        return;
                    }
                    await handleJoin(ws);
                    break;

                case 'draw':
                case 'draw_update':
                    if (participantId && canInteract(participantId)) {
                        if (data.type === 'draw') {
                            room.drawings.push({
                                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                                number: participantNumber,
                                color: data.color || '#4a9eff',
                                width: data.width || 3,
                                paths: data.paths || [],
                                sectionId: getParticipantSection(participantId)
                            });
                        } else {
                            const drawing = room.drawings[room.drawings.length - 1];
                            if (drawing && drawing.number === participantNumber) {
                                drawing.paths.push(...(data.paths || []));
                            }
                        }
                        broadcastToRoom({
                            type: 'drawing',
                            drawing: room.drawings[room.drawings.length - 1]
                        }, ws);
                    }
                    break;

                case 'text':
                    if (participantId && canInteract(participantId)) {
                        const textElement = {
                            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                            number: participantNumber,
                            content: data.content,
                            x: data.x,
                            y: data.y,
                            color: data.color || '#e0e0e0',
                            size: data.size || 20,
                            sectionId: getParticipantSection(participantId)
                        };
                        room.texts.push(textElement);
                        broadcastToRoom({
                            type: 'text_added',
                            text: textElement
                        }, ws);
                    }
                    break;

                case 'erase':
                    if (participantId && canInteract(participantId)) {
                        const eraseRadius = data.radius || 30;
                        const eraseX = data.x;
                        const eraseY = data.y;
                        const sectionId = getParticipantSection(participantId);

                        if (room.sessionPhase === 'open') {
                            room.drawings = room.drawings.filter(draw => {
                                const shouldErase = draw.paths.some(path => {
                                    const dist = Math.sqrt(Math.pow(path.x - eraseX, 2) + Math.pow(path.y - eraseY, 2));
                                    return dist < eraseRadius;
                                });
                                return !shouldErase;
                            });

                            room.texts = room.texts.filter(text => {
                                const dist = Math.sqrt(Math.pow(text.x - eraseX, 2) + Math.pow(text.y - eraseY, 2));
                                return dist >= eraseRadius;
                            });
                        } else {
                            room.drawings = room.drawings.filter(draw => {
                                if (draw.sectionId !== sectionId) return true;
                                const shouldErase = draw.paths.some(path => {
                                    const dist = Math.sqrt(Math.pow(path.x - eraseX, 2) + Math.pow(path.y - eraseY, 2));
                                    return dist < eraseRadius;
                                });
                                return !shouldErase;
                            });

                            room.texts = room.texts.filter(text => {
                                if (text.sectionId !== sectionId) return true;
                                const dist = Math.sqrt(Math.pow(text.x - eraseX, 2) + Math.pow(text.y - eraseY, 2));
                                return dist >= eraseRadius;
                            });
                        }

                        broadcastToRoom({
                            type: 'erased',
                            number: participantNumber,
                            drawings: room.drawings,
                            texts: room.texts
                        }, ws);
                    }
                    break;

                case 'vote_remove':
                    if (participantId && data.targetId && room.votingRound > 0) {
                        if (!room.votes[data.targetId]) {
                            room.votes[data.targetId] = 0;
                        }
                        room.votes[data.targetId]++;

                        broadcastToRoom({
                            type: 'vote_update',
                            targetId: data.targetId,
                            votes: room.votes[data.targetId]
                        });

                        if (room.votes[data.targetId] >= 4) {
                            removeParticipant(data.targetId);
                        }
                    }
                    break;

                case 'request_voting':
                    if (participantId) {
                        room.votingRound = data.round || 1;
                        room.votes = {};
                        broadcastToRoom({
                            type: 'voting_started',
                            round: room.votingRound
                        });
                        
                        setTimeout(() => {
                            room.votingRound = 0;
                            broadcastToRoom({ type: 'voting_ended' });
                        }, 60000);
                    }
                    break;

                case 'request_sections_phase':
                    if (participantId) {
                        room.sessionPhase = 'sections';
                        const remainingNumbers = getActiveParticipantsList()
                            .map(p => p.number)
                            .sort((a, b) => a - b);
                        broadcastToRoom({
                            type: 'sections_phase',
                            remainingNumbers: remainingNumbers
                        });
                    }
                    break;

                case 'create_section':
                    if (participantId && data.inviteeIds) {
                        const inviter = room.participants.get(participantId);
                        if (!inviter) break;

                        if (data.inviteeIds.length + 1 > 3) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Section cannot exceed 3 participants'
                            }));
                            break;
                        }

                        const sectionId = `section-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                        const members = [{ id: participantId, number: participantNumber }];
                        
                        data.inviteeIds.forEach(id => {
                            const member = room.participants.get(id);
                            if (member && member.ws.readyState === WebSocket.OPEN) {
                                members.push({ id: id, number: member.number });
                            }
                        });

                        const section = {
                            id: sectionId,
                            members: members,
                            locked: false
                        };

                        room.sections.push(section);

                        members.forEach(member => {
                            if (member.id !== participantId) {
                                const memberData = room.participants.get(member.id);
                                if (memberData && memberData.ws.readyState === WebSocket.OPEN) {
                                    memberData.ws.send(JSON.stringify({
                                        type: 'section_invitation',
                                        sectionId: sectionId,
                                        inviterNumber: participantNumber,
                                        members: members
                                    }));
                                }
                            }
                        });

                        broadcastToRoom({
                            type: 'section_created',
                            section: section
                        }, ws);
                    }
                    break;

                case 'accept_section_invitation':
                    if (participantId && data.sectionId) {
                        const section = room.sections.find(s => s.id === data.sectionId);
                        if (section) {
                            const member = section.members.find(m => m.id === participantId);
                            if (member && !member.accepted) {
                                member.accepted = true;
                                
                                if (section.members.every(m => m.accepted)) {
                                    section.locked = true;
                                    section.members.forEach(m => {
                                        const memberData = room.participants.get(m.id);
                                        if (memberData && memberData.ws.readyState === WebSocket.OPEN) {
                                            memberData.ws.send(JSON.stringify({
                                                type: 'section_joined',
                                                sectionId: section.id
                                            }));
                                        }
                                    });
                                }
                            }
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        const participantId = ws._participantId;
        
        if (participantId && room.participants.has(participantId)) {
            const participant = room.participants.get(participantId);
            room.participants.delete(participantId);

            // Remove from sections
            room.sections.forEach(section => {
                section.members = section.members.filter(m => m.id !== participantId);
                if (section.members.length === 0) {
                    room.sections = room.sections.filter(s => s.id !== section.id);
                }
            });

            broadcastToRoom({
                type: 'participant_left',
                participantId: participantId,
                number: participant.number
            }, ws);

            console.log(`Participant #${participant.number} left. Active count: ${getActiveCount()}/${MAX_PARTICIPANTS}`);
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`INTERACTION ATLAS server running on port ${PORT}`);
    console.log(`Single room with STRICT max ${MAX_PARTICIPANTS} participants`);
    console.log(`New participants will be rejected when room is full`);
});
