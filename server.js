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

const rooms = new Map(); // roomId -> { participants, drawings, texts, votes, nextNumber, sections }

function assignNumber(room) {
    // Assign numbers 1-20 to participants
    const usedNumbers = Array.from(room.participants.values()).map(p => p.number);
    for (let i = 1; i <= 20; i++) {
        if (!usedNumbers.includes(i)) {
            return i;
        }
    }
    return null; // Room is full
}

wss.on('connection', (ws) => {
    let roomId = null;
    let participantId = null;
    let participantNumber = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    // Prevent duplicate joins - if already joined, ignore
                    if (participantId) {
                        console.log('Participant already joined, ignoring duplicate join');
                        return;
                    }

                    roomId = data.roomId || 'default';
                    participantId = `${Date.now()}-${Math.random()}`;

                    if (!rooms.has(roomId)) {
                        rooms.set(roomId, {
                            participants: new Map(),
                            drawings: [],
                            texts: [],
                            votes: {},
                            nextNumber: 1,
                            sections: [],
                            startTime: Date.now(),
                            votingRound: 0,
                            sessionPhase: 'open'
                        });
                    }

                    const room = rooms.get(roomId);

                    // Clean up dead connections first
                    room.participants.forEach((participant, id) => {
                        if (participant.ws.readyState !== WebSocket.OPEN) {
                            room.participants.delete(id);
                        }
                    });

                    // Check room capacity (max 20) - strict check AFTER cleanup
                    if (room.participants.size >= 20) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Room is full (max 20 participants)'
                        }));
                        ws.close();
                        return;
                    }

                    // Assign number
                    participantNumber = assignNumber(room);
                    if (!participantNumber) {
                        // Double check after number assignment
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Room is full (max 20 participants)'
                        }));
                        ws.close();
                        return;
                    }

                    room.participants.set(participantId, {
                        id: participantId,
                        number: participantNumber,
                        ws: ws
                    });

                    // Only include active participants (with open connections)
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
                        votingRound: room.votingRound
                    }));

                    // Notify others
                    broadcastToRoom(roomId, {
                        type: 'participant_joined',
                        participant: {
                            id: participantId,
                            number: participantNumber
                        }
                    }, ws);

                    // Start voting phases automatically
                    startVotingPhases(roomId);

                    break;

                case 'draw':
                case 'draw_update':
                    if (roomId && participantId) {
                        const room = rooms.get(roomId);
                        if (canInteract(room, participantId)) {
                            if (data.type === 'draw') {
                                room.drawings.push({
                                    id: `${Date.now()}-${Math.random()}`,
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
                        if (canInteract(room, participantId)) {
                            const textElement = {
                                id: `${Date.now()}-${Math.random()}`,
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
                        if (canInteract(room, participantId)) {
                            const eraseRadius = data.radius || 30;
                            const eraseX = data.x;
                            const eraseY = data.y;
                            const sectionId = getParticipantSection(room, participantId);

                            // Remove erased drawings (only from user's section or open phase)
                            room.drawings = room.drawings.filter(draw => {
                                if (room.sessionPhase === 'open') {
                                    const shouldErase = draw.paths.some(path => {
                                        const dist = Math.sqrt(Math.pow(path.x - eraseX, 2) + Math.pow(path.y - eraseY, 2));
                                        return dist < eraseRadius;
                                    });
                                    return !shouldErase;
                                } else {
                                    // In sections phase, can only erase in own section
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
                            }, ws);
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
                        
                        // End voting after 1 minute
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
                        const remainingNumbers = Array.from(room.participants.values()).map(p => p.number).sort((a, b) => a - b);
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
                        const sectionId = `section-${Date.now()}-${Math.random()}`;
                        
                        // Check section size (max 3)
                        if (data.inviteeIds.length + 1 > 3) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Section cannot exceed 3 participants'
                            }));
                            break;
                        }

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

                        // Send invitations
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
                        }, ws);
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
                                
                                // Check if all members accepted
                                const allAccepted = section.members.every(m => m.accepted);
                                if (allAccepted) {
                                    section.locked = true;
                                    // Notify all section members
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
                if (room.participants.size === 0) {
                    setTimeout(() => {
                        if (rooms.has(roomId) && rooms.get(roomId).participants.size === 0) {
                            rooms.delete(roomId);
                        }
                    }, 300000);
                }
            }
        }
    });
});

function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;

    const data = JSON.stringify(message);
    room.participants.forEach((participant) => {
        if (participant.ws !== excludeWs && participant.ws.readyState === WebSocket.OPEN) {
            participant.ws.send(data);
        }
    });
}

function removeParticipant(roomId, participantId) {
    const room = rooms.get(roomId);
    if (!room || !room.participants.has(participantId)) return;

    const participant = room.participants.get(participantId);
    
    // Close their connection
    if (participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(JSON.stringify({
            type: 'removed',
            reason: 'Voted out by participants'
        }));
        participant.ws.close();
    }

    room.participants.delete(participantId);
    delete room.votes[participantId];

    broadcastToRoom(roomId, {
        type: 'participant_removed',
        participantId: participantId,
        number: participant.number
    });
}

function startVotingPhases(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.votingRound > 0) return; // Already started
    
    // Schedule voting phases at 20, 40, 60 minutes
    const elapsed = Date.now() - room.startTime;
    const timeTo20Min = 20 * 60000 - elapsed;
    const timeTo40Min = 40 * 60000 - elapsed;
    const timeTo60Min = 60 * 60000 - elapsed;
    
    if (timeTo20Min > 0) {
        setTimeout(() => {
            if (rooms.has(roomId)) {
                const r = rooms.get(roomId);
                r.votingRound = 1;
                r.votes = {};
                broadcastToRoom(roomId, {
                    type: 'voting_started',
                    round: 1
                });
                setTimeout(() => {
                    if (rooms.has(roomId)) {
                        rooms.get(roomId).votingRound = 0;
                        broadcastToRoom(roomId, { type: 'voting_ended' });
                    }
                }, 60000);
            }
        }, timeTo20Min);
    }
    
    if (timeTo40Min > 0) {
        setTimeout(() => {
            if (rooms.has(roomId)) {
                const r = rooms.get(roomId);
                r.votingRound = 2;
                r.votes = {};
                broadcastToRoom(roomId, {
                    type: 'voting_started',
                    round: 2
                });
                setTimeout(() => {
                    if (rooms.has(roomId)) {
                        rooms.get(roomId).votingRound = 0;
                        broadcastToRoom(roomId, { type: 'voting_ended' });
                    }
                }, 60000);
            }
        }, timeTo40Min);
    }
    
    if (timeTo60Min > 0) {
        setTimeout(() => {
            if (rooms.has(roomId)) {
                const r = rooms.get(roomId);
                r.votingRound = 3;
                r.votes = {};
                broadcastToRoom(roomId, {
                    type: 'voting_started',
                    round: 3
                });
                setTimeout(() => {
                    if (rooms.has(roomId)) {
                        const room = rooms.get(roomId);
                        room.votingRound = 0;
                        room.sessionPhase = 'sections';
                        const remainingNumbers = Array.from(room.participants.values()).map(p => p.number).sort((a, b) => a - b);
                        broadcastToRoom(roomId, {
                            type: 'voting_ended'
                        });
                        setTimeout(() => {
                            if (rooms.has(roomId)) {
                                broadcastToRoom(roomId, {
                                    type: 'sections_phase',
                                    remainingNumbers: remainingNumbers
                                });
                            }
                        }, 1000);
                    }
                }, 60000);
            }
        }, timeTo60Min);
    }
}

function canInteract(room, participantId) {
    if (room.sessionPhase === 'open') return true;
    
    // In sections phase, check if participant is in a locked section
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
    console.log(`INTERACTION ATLAS server running on port ${PORT}`);
    console.log(`Connect clients to: ws://localhost:${PORT}`);
});
