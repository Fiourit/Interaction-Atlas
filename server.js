// WebSocket server for INTERACTION ATLAS
// Run with: node server.js
// Requires: npm install ws

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    // Serve the HTML file at root
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

const rooms = new Map(); // roomId -> { participants, drawings, texts, votes, sections }
const MAX_PARTICIPANTS = 20;

// Room cleanup interval - remove stale connections every 30 seconds
setInterval(() => {
    rooms.forEach((room, roomId) => {
        cleanupStaleConnections(roomId);
    });
}, 30000);

function cleanupStaleConnections(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const before = room.participants.size;
    room.participants.forEach((participant, id) => {
        if (participant.ws.readyState !== WebSocket.OPEN) {
            console.log(`Cleaning up stale connection for participant ${id} in room ${roomId}`);
            room.participants.delete(id);
        }
    });
    const after = room.participants.size;
    
    if (before !== after) {
        console.log(`Room ${roomId}: Cleaned up ${before - after} stale connections. Now: ${after}/${MAX_PARTICIPANTS}`);
        broadcastParticipantUpdate(roomId);
    }
}

function assignNumber(room) {
    // Assign numbers 1-20 to participants
    const usedNumbers = Array.from(room.participants.values()).map(p => p.number);
    for (let i = 1; i <= MAX_PARTICIPANTS; i++) {
        if (!usedNumbers.includes(i)) {
            return i;
        }
    }
    return null; // Room is full
}

function getActiveParticipantCount(room) {
    let count = 0;
    room.participants.forEach((participant) => {
        if (participant.ws.readyState === WebSocket.OPEN) {
            count++;
        }
    });
    return count;
}

function broadcastParticipantUpdate(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    const activeParticipants = Array.from(room.participants.values())
        .filter(p => p.ws.readyState === WebSocket.OPEN)
        .map(p => ({
            id: p.id,
            number: p.number
        }));

    broadcastToRoom(roomId, {
        type: 'participants_update',
        participants: activeParticipants,
        count: activeParticipants.length
    });
}

wss.on('connection', (ws) => {
    let roomId = null;
    let participantId = null;
    let participantNumber = null;
    let joinProcessed = false;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    // Prevent duplicate joins
                    if (joinProcessed || participantId) {
                        console.log(`Duplicate join attempt blocked for ${participantId}`);
                        return;
                    }
                    joinProcessed = true;

                    roomId = data.roomId || 'default';
                    console.log(`Join request for room: "${roomId}"`);

                    // Initialize room if it doesn't exist
                    if (!rooms.has(roomId)) {
                        rooms.set(roomId, {
                            participants: new Map(),
                            drawings: [],
                            texts: [],
                            votes: {},
                            sections: [],
                            startTime: Date.now(),
                            votingRound: 0,
                            sessionPhase: 'open'
                        });
                        console.log(`Created new room: ${roomId}`);
                    }

                    const room = rooms.get(roomId);

                    // CRITICAL: Clean up dead connections BEFORE checking capacity
                    cleanupStaleConnections(roomId);

                    // STRICT CAPACITY CHECK: Must have fewer than MAX_PARTICIPANTS
                    const activeCount = getActiveParticipantCount(room);
                    console.log(`Room ${roomId} capacity check: ${activeCount}/${MAX_PARTICIPANTS} active participants`);

                    if (activeCount >= MAX_PARTICIPANTS) {
                        console.log(`Room ${roomId} is FULL (${activeCount}/${MAX_PARTICIPANTS}). Rejecting participant.`);
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Room is full (${MAX_PARTICIPANTS}/${MAX_PARTICIPANTS} participants)`
                        }));
                        ws.close(1000, 'Room is full');
                        joinProcessed = false;
                        return;
                    }

                    // Assign unique number
                    participantNumber = assignNumber(room);
                    if (!participantNumber) {
                        console.log(`No available number in room ${roomId}. Rejecting.`);
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Room is full (no available numbers)'
                        }));
                        ws.close(1000, 'Room is full');
                        joinProcessed = false;
                        return;
                    }

                    // Generate unique participant ID
                    participantId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                    // Add participant to room
                    room.participants.set(participantId, {
                        id: participantId,
                        number: participantNumber,
                        ws: ws,
                        joinedAt: Date.now()
                    });

                    // Verify we didn't exceed limit (safety check)
                    const finalCount = getActiveParticipantCount(room);
                    if (finalCount > MAX_PARTICIPANTS) {
                        console.error(`CRITICAL: Room ${roomId} exceeded ${MAX_PARTICIPANTS} participants! Rolling back.`);
                        room.participants.delete(participantId);
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Room capacity exceeded'
                        }));
                        ws.close(1000, 'Capacity exceeded');
                        joinProcessed = false;
                        return;
                    }

                    console.log(`✓ Participant #${participantNumber} joined room ${roomId}. Total: ${finalCount}/${MAX_PARTICIPANTS}`);

                    // Get current active participants
                    const activeParticipants = Array.from(room.participants.values())
                        .filter(p => p.ws.readyState === WebSocket.OPEN)
                        .map(p => ({
                            id: p.id,
                            number: p.number
                        }));

                    // Send current state to new participant
                    ws.send(JSON.stringify({
                        type: 'joined',
                        participantId: participantId,
                        number: participantNumber,
                        participants: activeParticipants,
                        drawings: room.drawings,
                        texts: room.texts,
                        sessionPhase: room.sessionPhase,
                        votingRound: room.votingRound,
                        maxParticipants: MAX_PARTICIPANTS
                    }));

                    // Notify others
                    broadcastToRoom(roomId, {
                        type: 'participant_joined',
                        participant: {
                            id: participantId,
                            number: participantNumber
                        },
                        totalCount: finalCount
                    }, ws);

                    // Start voting phases automatically (only once per room)
                    if (!room.votingScheduled) {
                        room.votingScheduled = true;
                        startVotingPhases(roomId);
                    }

                    break;

                case 'draw':
                case 'draw_update':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (canInteract(room, participantId)) {
                            if (data.type === 'draw') {
                                const drawingId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                                room.drawings.push({
                                    id: drawingId,
                                    number: participantNumber,
                                    color: data.color || '#4a9eff',
                                    width: data.width || 3,
                                    paths: data.paths || [],
                                    sectionId: getParticipantSection(room, participantId)
                                });
                                broadcastToRoom(roomId, {
                                    type: 'drawing',
                                    drawing: room.drawings[room.drawings.length - 1]
                                });
                            } else {
                                const drawing = room.drawings[room.drawings.length - 1];
                                if (drawing && drawing.number === participantNumber) {
                                    drawing.paths.push(...(data.paths || []));
                                    broadcastToRoom(roomId, {
                                        type: 'drawing_update',
                                        drawingId: drawing.id,
                                        paths: data.paths
                                    });
                                }
                            }
                        }
                    }
                    break;

                case 'text':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (canInteract(room, participantId)) {
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
                            });
                        }
                    }
                    break;

                case 'erase':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (canInteract(room, participantId)) {
                            const eraseRadius = data.radius || 30;
                            const eraseX = data.x;
                            const eraseY = data.y;
                            const sectionId = getParticipantSection(room, participantId);

                            // Remove erased drawings
                            room.drawings = room.drawings.filter(draw => {
                                if (room.sessionPhase === 'open') {
                                    const shouldErase = draw.paths.some(path => {
                                        const dist = Math.sqrt(Math.pow(path.x - eraseX, 2) + Math.pow(path.y - eraseY, 2));
                                        return dist < eraseRadius;
                                    });
                                    return !shouldErase;
                                } else {
                                    if (draw.sectionId !== sectionId) return true;
                                    const shouldErase = draw.paths.some(path => {
                                        const dist = Math.sqrt(Math.pow(path.x - eraseX, 2) + Math.pow(path.y - eraseY, 2));
                                        return dist < eraseRadius;
                                    });
                                    return !shouldErase;
                                }
                            });

                            // Remove erased texts
                            room.texts = room.texts.filter(text => {
                                if (room.sessionPhase === 'open') {
                                    const dist = Math.sqrt(Math.pow(text.x - eraseX, 2) + Math.pow(text.y - eraseY, 2));
                                    return dist >= eraseRadius;
                                } else {
                                    if (text.sectionId !== sectionId) return true;
                                    const dist = Math.sqrt(Math.pow(text.x - eraseX, 2) + Math.pow(text.y - eraseY, 2));
                                    return dist >= eraseRadius;
                                }
                            });

                            broadcastToRoom(roomId, {
                                type: 'erased',
                                number: participantNumber,
                                drawings: room.drawings,
                                texts: room.texts
                            });
                        }
                    }
                    break;

                case 'vote_remove':
                    if (roomId && participantId && data.targetId && room.votingRound > 0) {
                        const room = rooms.get(roomId);
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
                    break;

                case 'request_voting':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        room.votingRound = data.round;
                        room.votes = {};
                        broadcastToRoom(roomId, {
                            type: 'voting_started',
                            round: data.round
                        });
                        
                        setTimeout(() => {
                            if (rooms.has(roomId)) {
                                rooms.get(roomId).votingRound = 0;
                                broadcastToRoom(roomId, {
                                    type: 'voting_ended'
                                });
                            }
                        }, 60000);
                    }
                    break;

                case 'request_sections_phase':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        room.sessionPhase = 'sections';
                        const remainingNumbers = Array.from(room.participants.values())
                            .filter(p => p.ws.readyState === WebSocket.OPEN)
                            .map(p => p.number)
                            .sort((a, b) => a - b);
                        broadcastToRoom(roomId, {
                            type: 'sections_phase',
                            remainingNumbers: remainingNumbers
                        });
                    }
                    break;

                case 'create_section':
                    if (roomId && participantId && data.inviteeIds) {
                        const room = rooms.get(roomId);
                        const inviter = room.participants.get(participantId);
                        
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
                            if (member) members.push({ id: id, number: member.number });
                        });

                        const section = {
                            id: sectionId,
                            members: members,
                            locked: false
                        };

                        room.sections.push(section);

                        members.forEach(member => {
                            if (member.id !== participantId) {
                                const memberWs = room.participants.get(member.id);
                                if (memberWs && memberWs.ws.readyState === WebSocket.OPEN) {
                                    memberWs.ws.send(JSON.stringify({
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
                        });
                    }
                    break;

                case 'accept_section_invitation':
                    if (roomId && participantId && data.sectionId) {
                        const room = rooms.get(roomId);
                        const section = room.sections.find(s => s.id === data.sectionId);
                        if (section) {
                            const member = section.members.find(m => m.id === participantId);
                            if (member && !member.accepted) {
                                member.accepted = true;
                                
                                const allAccepted = section.members.every(m => m.accepted);
                                if (allAccepted) {
                                    section.locked = true;
                                    section.members.forEach(m => {
                                        const memberWs = room.participants.get(m.id);
                                        if (memberWs && memberWs.ws.readyState === WebSocket.OPEN) {
                                            memberWs.ws.send(JSON.stringify({
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

                case 'heartbeat':
                    // Simple heartbeat response to keep connection alive
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
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
                
                console.log(`Participant #${participantNumber} left room ${roomId}. Remaining: ${getActiveParticipantCount(room)}/${MAX_PARTICIPANTS}`);
                
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
                    number: participant.number,
                    totalCount: getActiveParticipantCount(room)
                });

                // Clean up empty rooms after 5 minutes
                if (room.participants.size === 0) {
                    setTimeout(() => {
                        if (rooms.has(roomId) && rooms.get(roomId).participants.size === 0) {
                            console.log(`Deleting empty room: ${roomId}`);
                            rooms.delete(roomId);
                        }
                    }, 300000);
                }
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;

    const data = JSON.stringify(message);
    room.participants.forEach((participant) => {
        if (participant.ws !== excludeWs && participant.ws.readyState === WebSocket.OPEN) {
            try {
                participant.ws.send(data);
            } catch (error) {
                console.error(`Error broadcasting to participant ${participant.id}:`, error);
            }
        }
    });
}

function removeParticipant(roomId, participantId) {
    const room = rooms.get(roomId);
    if (!room || !room.participants.has(participantId)) return;

    const participant = room.participants.get(participantId);
    
    if (participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify({
            type: 'removed',
            reason: 'Voted out by participants'
        }));
        participant.ws.close(1000, 'Voted out');
    }

    room.participants.delete(participantId);
    delete room.votes[participantId];

    console.log(`Participant #${participant.number} removed from room ${roomId}. Remaining: ${getActiveParticipantCount(room)}/${MAX_PARTICIPANTS}`);

    broadcastToRoom(roomId, {
        type: 'participant_removed',
        participantId: participantId,
        number: participant.number,
        totalCount: getActiveParticipantCount(room)
    });
}

function startVotingPhases(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const scheduleVoting = (minutes, round) => {
        const elapsed = Date.now() - room.startTime;
        const timeToVoting = minutes * 60000 - elapsed;
        
        if (timeToVoting > 0) {
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
                            const r = rooms.get(roomId);
                            r.votingRound = 0;
                            broadcastToRoom(roomId, { type: 'voting_ended' });
                            
                            if (round === 3) {
                                setTimeout(() => {
                                    if (rooms.has(roomId)) {
                                        r.sessionPhase = 'sections';
                                        const remainingNumbers = Array.from(r.participants.values())
                                            .filter(p => p.ws.readyState === WebSocket.OPEN)
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
            }, timeToVoting);
        }
    };
    
    scheduleVoting(20, 1);
    scheduleVoting(40, 2);
    scheduleVoting(60, 3);
}

function canInteract(room, participantId) {
    if (room.sessionPhase === 'open') return true;
    
    const section = room.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return !!section;
}

function getParticipantSection(room, participantId) {
    if (room.sessionPhase === 'open') return null;
    const section = room.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return section ? section.id : null;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`═══════════════════════════════════════`);
    console.log(`  INTERACTION ATLAS Server`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Max Participants: ${MAX_PARTICIPANTS}`);
    console.log(`═══════════════════════════════════════`);
});