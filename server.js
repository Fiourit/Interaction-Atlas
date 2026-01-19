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

// Room storage
const rooms = new Map(); // roomId -> Room object
const roomJoinLocks = new Map(); // roomId -> Promise for serializing joins

// Room class to encapsulate room logic
class Room {
    constructor(roomId) {
        this.roomId = roomId;
        this.participants = new Map(); // participantId -> { id, number, ws }
        this.drawings = [];
        this.texts = [];
        this.votes = {};
        this.sections = [];
        this.startTime = Date.now();
        this.votingRound = 0;
        this.sessionPhase = 'open';
    }

    // Get count of active participants only
    getActiveCount() {
        let count = 0;
        this.participants.forEach(participant => {
            if (participant.ws.readyState === WebSocket.OPEN) {
                count++;
            }
        });
        return count;
    }

    // Clean up dead connections and return active count
    cleanupAndCount() {
        const toDelete = [];
        this.participants.forEach((participant, id) => {
            if (participant.ws.readyState !== WebSocket.OPEN) {
                toDelete.push(id);
            }
        });
        toDelete.forEach(id => this.participants.delete(id));
        return this.getActiveCount();
    }

    // Get available participant number (1-20)
    getAvailableNumber() {
        const usedNumbers = new Set();
        this.participants.forEach(participant => {
            if (participant.ws.readyState === WebSocket.OPEN) {
                usedNumbers.add(participant.number);
            }
        });

        for (let i = 1; i <= MAX_PARTICIPANTS; i++) {
            if (!usedNumbers.has(i)) {
                return i;
            }
        }
        return null; // Room is full
    }

    // Get list of active participants for broadcasting
    getActiveParticipantsList() {
        const list = [];
        this.participants.forEach(participant => {
            if (participant.ws.readyState === WebSocket.OPEN) {
                list.push({
                    id: participant.id,
                    number: participant.number
                });
            }
        });
        return list;
    }
}

// Serialize join operations per room to prevent race conditions
async function withJoinLock(roomId, operation) {
    if (!roomJoinLocks.has(roomId)) {
        roomJoinLocks.set(roomId, Promise.resolve());
    }
    
    const currentLock = roomJoinLocks.get(roomId);
    const newLock = currentLock.then(async () => {
        try {
            return await operation();
        } catch (error) {
            console.error(`Error in join operation for room ${roomId}:`, error);
            throw error;
        }
    });
    
    roomJoinLocks.set(roomId, newLock);
    await newLock;
}

// Get or create room
function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Room(roomId));
    }
    return rooms.get(roomId);
}

// Handle participant joining
async function handleJoin(ws, data) {
    const roomId = data.roomId || 'default';
    
    return await withJoinLock(roomId, async () => {
        const room = getOrCreateRoom(roomId);
        
        // Clean up dead connections first
        const activeCount = room.cleanupAndCount();
        
        // Check if room is full
        if (activeCount >= MAX_PARTICIPANTS) {
            console.log(`Room ${roomId} is full (${activeCount}/${MAX_PARTICIPANTS}). Rejecting join.`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Room is full (max 20 participants)'
                }));
                ws.close();
            }
            return null;
        }

        // Get available number
        const participantNumber = room.getAvailableNumber();
        if (!participantNumber) {
            console.log(`No available number in room ${roomId} (${activeCount} active). Rejecting.`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Room is full (max 20 participants)'
                }));
                ws.close();
            }
            return null;
        }

        // Double-check we're still under limit
        const finalCount = room.getActiveCount();
        if (finalCount >= MAX_PARTICIPANTS) {
            console.log(`Room ${roomId} became full during join (${finalCount}/${MAX_PARTICIPANTS}). Rejecting.`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Room is full (max 20 participants)'
                }));
                ws.close();
            }
            return null;
        }

        // Create participant ID
        const participantId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Add participant
        room.participants.set(participantId, {
            id: participantId,
            number: participantNumber,
            ws: ws
        });

        // Final safety check
        const verifyCount = room.getActiveCount();
        if (verifyCount > MAX_PARTICIPANTS) {
            console.error(`CRITICAL: Room ${roomId} exceeded limit (${verifyCount}/${MAX_PARTICIPANTS})! Removing last participant.`);
            room.participants.delete(participantId);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Room is full (max 20 participants)'
                }));
                ws.close();
            }
            return null;
        }

        // Get active participants list
        const activeParticipants = room.getActiveParticipantsList();

        // Send join confirmation
        if (ws.readyState === WebSocket.OPEN) {
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

            // Notify other participants
            broadcastToRoom(roomId, {
                type: 'participant_joined',
                participant: {
                    id: participantId,
                    number: participantNumber
                }
            }, ws);

            // Start voting phases if not already started
            startVotingPhases(roomId);
        }

        return { roomId, participantId, participantNumber };
    });
}

// Broadcast message to all participants in a room
function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;

    const data = JSON.stringify(message);
    room.participants.forEach(participant => {
        if (participant.ws !== excludeWs && participant.ws.readyState === WebSocket.OPEN) {
            try {
                participant.ws.send(data);
            } catch (error) {
                console.error('Error broadcasting to participant:', error);
            }
        }
    });
}

// Remove participant from room
function removeParticipant(roomId, participantId) {
    const room = rooms.get(roomId);
    if (!room || !room.participants.has(participantId)) return;

    const participant = room.participants.get(participantId);
    
    // Close connection
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

    broadcastToRoom(roomId, {
        type: 'participant_removed',
        participantId: participantId,
        number: participant.number
    });
}

// Check if participant can interact
function canInteract(room, participantId) {
    if (room.sessionPhase === 'open') return true;
    
    const section = room.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return !!section;
}

// Get participant's section ID
function getParticipantSection(room, participantId) {
    if (room.sessionPhase === 'open') return null;
    const section = room.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return section ? section.id : null;
}

// Start voting phases for a room
function startVotingPhases(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.votingRound > 0) return; // Already started
    
    const elapsed = Date.now() - room.startTime;
    const scheduleVoting = (round, delay) => {
        if (delay > 0) {
            setTimeout(() => {
                if (rooms.has(roomId)) {
                    const r = rooms.get(roomId);
                    r.votingRound = round;
                    r.votes = {};
                    broadcastToRoom(roomId, {
                        type: 'voting_started',
                        round: round
                    });
                    
                    setTimeout(() => {
                        if (rooms.has(roomId)) {
                            rooms.get(roomId).votingRound = 0;
                            broadcastToRoom(roomId, { type: 'voting_ended' });
                            
                            if (round === 3) {
                                setTimeout(() => {
                                    if (rooms.has(roomId)) {
                                        const rm = rooms.get(roomId);
                                        rm.sessionPhase = 'sections';
                                        const remainingNumbers = rm.getActiveParticipantsList()
                                            .map(p => p.number)
                                            .sort((a, b) => a - b);
                                        broadcastToRoom(roomId, {
                                            type: 'sections_phase',
                                            remainingNumbers: remainingNumbers
                                        });
                                    }
                                }, 1000);
                            }
                        }
                    }, 60000);
                }
            }, delay);
        }
    };

    scheduleVoting(1, 20 * 60000 - elapsed);
    scheduleVoting(2, 40 * 60000 - elapsed);
    scheduleVoting(3, 60 * 60000 - elapsed);
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    let roomId = null;
    let participantId = null;
    let participantNumber = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    // Prevent duplicate joins
                    if (participantId) {
                        console.log('Duplicate join attempt ignored');
                        return;
                    }

                    const joinResult = await handleJoin(ws, data);
                    if (joinResult) {
                        roomId = joinResult.roomId;
                        participantId = joinResult.participantId;
                        participantNumber = joinResult.participantNumber;
                    }
                    break;

                case 'draw':
                case 'draw_update':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (room && canInteract(room, participantId)) {
                            if (data.type === 'draw') {
                                room.drawings.push({
                                    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                                    number: participantNumber,
                                    color: data.color || '#4a9eff',
                                    width: data.width || 3,
                                    paths: data.paths || [],
                                    sectionId: getParticipantSection(room, participantId)
                                });
                            } else {
                                const drawing = room.drawings[room.drawings.length - 1];
                                if (drawing && drawing.number === participantNumber) {
                                    drawing.paths.push(...(data.paths || []));
                                }
                            }
                            broadcastToRoom(roomId, {
                                type: 'drawing',
                                drawing: room.drawings[room.drawings.length - 1]
                            }, ws);
                        }
                    }
                    break;

                case 'text':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (room && canInteract(room, participantId)) {
                            const textElement = {
                                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                                number: participantNumber,
                                content: data.content,
                                x: data.x,
                                y: data.y,
                                color: data.color || '#e0e0e0',
                                size: data.size || 20,
                                sectionId: getParticipantSection(room, participantId)
                            };
                            room.texts.push(textElement);
                            broadcastToRoom(roomId, {
                                type: 'text_added',
                                text: textElement
                            }, ws);
                        }
                    }
                    break;

                case 'erase':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (room && canInteract(room, participantId)) {
                            const eraseRadius = data.radius || 30;
                            const eraseX = data.x;
                            const eraseY = data.y;
                            const sectionId = getParticipantSection(room, participantId);

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

                            broadcastToRoom(roomId, {
                                type: 'erased',
                                number: participantNumber,
                                drawings: room.drawings,
                                texts: room.texts
                            }, ws);
                        }
                    }
                    break;

                case 'vote_remove':
                    if (roomId && participantId && data.targetId) {
                        const room = rooms.get(roomId);
                        if (room && room.votingRound > 0) {
                            if (!room.votes[data.targetId]) {
                                room.votes[data.targetId] = 0;
                            }
                            room.votes[data.targetId]++;

                            broadcastToRoom(roomId, {
                                type: 'vote_update',
                                targetId: data.targetId,
                                votes: room.votes[data.targetId]
                            });

                            if (room.votes[data.targetId] >= 4) {
                                removeParticipant(roomId, data.targetId);
                            }
                        }
                    }
                    break;

                case 'request_voting':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (room) {
                            room.votingRound = data.round || 1;
                            room.votes = {};
                            broadcastToRoom(roomId, {
                                type: 'voting_started',
                                round: room.votingRound
                            });
                            
                            setTimeout(() => {
                                if (rooms.has(roomId)) {
                                    rooms.get(roomId).votingRound = 0;
                                    broadcastToRoom(roomId, { type: 'voting_ended' });
                                }
                            }, 60000);
                        }
                    }
                    break;

                case 'request_sections_phase':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (room) {
                            room.sessionPhase = 'sections';
                            const remainingNumbers = room.getActiveParticipantsList()
                                .map(p => p.number)
                                .sort((a, b) => a - b);
                            broadcastToRoom(roomId, {
                                type: 'sections_phase',
                                remainingNumbers: remainingNumbers
                            });
                        }
                    }
                    break;

                case 'create_section':
                    if (roomId && participantId && data.inviteeIds) {
                        const room = rooms.get(roomId);
                        if (room) {
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
                            const members = [{ id: participantId, number: inviter.number }];
                            
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
                                            inviterNumber: inviter.number,
                                            members: members
                                        }));
                                    }
                                }
                            });

                            broadcastToRoom(roomId, {
                                type: 'section_created',
                                section: section
                            }, ws);
                        }
                    }
                    break;

                case 'accept_section_invitation':
                    if (roomId && participantId && data.sectionId) {
                        const room = rooms.get(roomId);
                        if (room) {
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
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        if (roomId && participantId) {
            const room = rooms.get(roomId);
            if (room && room.participants.has(participantId)) {
                const participant = room.participants.get(participantId);
                room.participants.delete(participantId);

                // Remove from sections
                room.sections.forEach(section => {
                    section.members = section.members.filter(m => m.id !== participantId);
                    if (section.members.length === 0) {
                        room.sections = room.sections.filter(s => s.id !== section.id);
                    }
                });

                broadcastToRoom(roomId, {
                    type: 'participant_left',
                    participantId: participantId,
                    number: participant.number
                }, ws);

                // Clean up empty rooms after 5 minutes
                if (room.getActiveCount() === 0) {
                    setTimeout(() => {
                        if (rooms.has(roomId) && rooms.get(roomId).getActiveCount() === 0) {
                            rooms.delete(roomId);
                            roomJoinLocks.delete(roomId);
                        }
                    }, 300000);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`INTERACTION ATLAS server running on port ${PORT}`);
    console.log(`Max participants per room: ${MAX_PARTICIPANTS}`);
});
