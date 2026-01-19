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

// SINGLE GLOBAL ROOM - Everyone joins this same room, always
const THE_ROOM = {
    participants: new Map(), // participantId -> { id, number, ws }
    drawings: [],
    texts: [],
    votes: {},
    sections: [],
    startTime: Date.now(),
    votingRound: 0,
    sessionPhase: 'open'
};

// Join lock to process one join at a time
let joinProcessing = false;
const pendingJoins = [];

// Get active participant count
function countActiveParticipants() {
    let count = 0;
    THE_ROOM.participants.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            count++;
        }
    });
    return count;
}

// Clean dead connections
function removeDeadConnections() {
    const dead = [];
    THE_ROOM.participants.forEach((p, id) => {
        if (!p.ws || p.ws.readyState !== WebSocket.OPEN) {
            dead.push(id);
        }
    });
    dead.forEach(id => {
        const p = THE_ROOM.participants.get(id);
        THE_ROOM.participants.delete(id);
        delete THE_ROOM.votes[id];
        // Clean sections
        THE_ROOM.sections.forEach(section => {
            section.members = section.members.filter(m => m.id !== id);
            if (section.members.length === 0) {
                THE_ROOM.sections = THE_ROOM.sections.filter(s => s.id !== section.id);
            }
        });
    });
    return countActiveParticipants();
}

// Get next available number (1-20)
function findNextNumber() {
    const used = new Set();
    THE_ROOM.participants.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN && p.number) {
            used.add(p.number);
        }
    });
    
    for (let num = 1; num <= MAX_PARTICIPANTS; num++) {
        if (!used.has(num)) {
            return num;
        }
    }
    return null;
}

// Get all active participants for broadcasting
function getAllActiveParticipants() {
    const list = [];
    THE_ROOM.participants.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            list.push({
                id: p.id,
                number: p.number
            });
        }
    });
    return list;
}

// Process join requests one at a time
async function processJoinQueue() {
    if (joinProcessing || pendingJoins.length === 0) return;
    
    joinProcessing = true;
    
    while (pendingJoins.length > 0) {
        const { ws, resolve } = pendingJoins.shift();
        
        // Check if WebSocket is still open
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            resolve(null);
            continue;
        }
        
        // Clean dead connections
        const activeBefore = removeDeadConnections();
        console.log(`[JOIN] Active participants before join: ${activeBefore}/${MAX_PARTICIPANTS}`);
        
        // Check if room is full
        if (activeBefore >= MAX_PARTICIPANTS) {
            console.log(`[JOIN] Room FULL! Rejecting. Active: ${activeBefore}/${MAX_PARTICIPANTS}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: `Room is full (${MAX_PARTICIPANTS} participants). Please try again later.`
            }));
            ws.close();
            resolve(null);
            continue;
        }
        
        // Get next available number
        const number = findNextNumber();
        if (!number) {
            console.log(`[JOIN] No number available. Active: ${activeBefore}/${MAX_PARTICIPANTS}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: `Room is full (${MAX_PARTICIPANTS} participants). Please try again later.`
            }));
            ws.close();
            resolve(null);
            continue;
        }
        
        // Create unique participant ID
        const participantId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Add participant
        THE_ROOM.participants.set(participantId, {
            id: participantId,
            number: number,
            ws: ws
        });
        
        // Attach to WebSocket
        ws._participantId = participantId;
        ws._participantNumber = number;
        
        // Verify count
        const activeAfter = countActiveParticipants();
        if (activeAfter > MAX_PARTICIPANTS) {
            console.error(`[ERROR] Exceeded limit! Count: ${activeAfter}, removing participant`);
            THE_ROOM.participants.delete(participantId);
            ws.send(JSON.stringify({
                type: 'error',
                message: `Room is full (${MAX_PARTICIPANTS} participants). Please try again later.`
            }));
            ws.close();
            resolve(null);
            continue;
        }
        
        console.log(`[JOIN] Participant #${number} joined! Active: ${activeAfter}/${MAX_PARTICIPANTS}`);
        
        // Get all active participants
        const allParticipants = getAllActiveParticipants();
        
        // Send join confirmation with all existing content
        ws.send(JSON.stringify({
            type: 'joined',
            participantId: participantId,
            number: number,
            participants: allParticipants,
            drawings: THE_ROOM.drawings,
            texts: THE_ROOM.texts,
            sessionPhase: THE_ROOM.sessionPhase,
            votingRound: THE_ROOM.votingRound
        }));
        
        // Tell others about new participant
        broadcastToAll({
            type: 'participant_joined',
            participant: {
                id: participantId,
                number: number
            }
        }, ws);
        
        // Start voting phases if needed
        startVotingPhases();
        
        resolve({ participantId, number });
    }
    
    joinProcessing = false;
}

// Handle join request
function handleJoinRequest(ws) {
    return new Promise((resolve) => {
        pendingJoins.push({ ws, resolve });
        processJoinQueue();
    });
}

// Broadcast to all participants
function broadcastToAll(message, excludeWs = null) {
    const data = JSON.stringify(message);
    THE_ROOM.participants.forEach(p => {
        if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
            try {
                p.ws.send(data);
            } catch (err) {
                console.error('[BROADCAST ERROR]', err);
            }
        }
    });
}

// Remove participant
function removeParticipant(participantId) {
    const p = THE_ROOM.participants.get(participantId);
    if (!p) return;
    
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        try {
            p.ws.send(JSON.stringify({
                type: 'removed',
                reason: 'Voted out by participants'
            }));
            p.ws.close();
        } catch (err) {
            console.error('[REMOVE ERROR]', err);
        }
    }
    
    THE_ROOM.participants.delete(participantId);
    delete THE_ROOM.votes[participantId];
    
    // Clean sections
    THE_ROOM.sections.forEach(section => {
        section.members = section.members.filter(m => m.id !== participantId);
        if (section.members.length === 0) {
            THE_ROOM.sections = THE_ROOM.sections.filter(s => s.id !== section.id);
        }
    });
    
    broadcastToAll({
        type: 'participant_removed',
        participantId: participantId,
        number: p.number
    });
    
    console.log(`[REMOVE] Participant #${p.number} removed. Active: ${countActiveParticipants()}/${MAX_PARTICIPANTS}`);
}

// Check if can interact
function canParticipantInteract(participantId) {
    if (THE_ROOM.sessionPhase === 'open') return true;
    const section = THE_ROOM.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return !!section;
}

// Get participant's section
function getParticipantSectionId(participantId) {
    if (THE_ROOM.sessionPhase === 'open') return null;
    const section = THE_ROOM.sections.find(s => 
        s.locked && s.members.some(m => m.id === participantId)
    );
    return section ? section.id : null;
}

// Start voting phases
function startVotingPhases() {
    if (THE_ROOM.votingRound > 0) return;
    
    const elapsed = Date.now() - THE_ROOM.startTime;
    
    function schedule(round, delay) {
        if (delay > 0) {
            setTimeout(() => {
                THE_ROOM.votingRound = round;
                THE_ROOM.votes = {};
                broadcastToAll({
                    type: 'voting_started',
                    round: round
                });
                
                setTimeout(() => {
                    THE_ROOM.votingRound = 0;
                    broadcastToAll({ type: 'voting_ended' });
                    
                    if (round === 3) {
                        setTimeout(() => {
                            THE_ROOM.sessionPhase = 'sections';
                            const numbers = getAllActiveParticipants()
                                .map(p => p.number)
                                .sort((a, b) => a - b);
                            broadcastToAll({
                                type: 'sections_phase',
                                remainingNumbers: numbers
                            });
                        }, 1000);
                    }
                }, 60000);
            }, delay);
        }
    }

    schedule(1, 20 * 60000 - elapsed);
    schedule(2, 40 * 60000 - elapsed);
    schedule(3, 60 * 60000 - elapsed);
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('[CONNECTION] New WebSocket connection');
    
    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            const participantId = ws._participantId;
            const participantNumber = ws._participantNumber;

            switch (data.type) {
                case 'join':
                    // Ignore if already joined
                    if (participantId) {
                        console.log('[JOIN] Already joined, ignoring');
                        return;
                    }
                    // Everyone joins THE_ROOM - ignore any room parameter
                    console.log('[JOIN] Processing join request');
                    await handleJoinRequest(ws);
                    break;

                case 'draw':
                case 'draw_update':
                    if (participantId && canParticipantInteract(participantId)) {
                        if (data.type === 'draw') {
                            THE_ROOM.drawings.push({
                                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                                number: participantNumber,
                                color: data.color || '#4a9eff',
                                width: data.width || 3,
                                paths: data.paths || [],
                                sectionId: getParticipantSectionId(participantId)
                            });
                        } else {
                            const last = THE_ROOM.drawings[THE_ROOM.drawings.length - 1];
                            if (last && last.number === participantNumber) {
                                last.paths.push(...(data.paths || []));
                            }
                        }
                        broadcastToAll({
                            type: 'drawing',
                            drawing: THE_ROOM.drawings[THE_ROOM.drawings.length - 1]
                        }, ws);
                    }
                    break;

                case 'text':
                    if (participantId && canParticipantInteract(participantId)) {
                        const text = {
                            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                            number: participantNumber,
                            content: data.content,
                            x: data.x,
                            y: data.y,
                            color: data.color || '#e0e0e0',
                            size: data.size || 20,
                            sectionId: getParticipantSectionId(participantId)
                        };
                        THE_ROOM.texts.push(text);
                        broadcastToAll({
                            type: 'text_added',
                            text: text
                        }, ws);
                    }
                    break;

                case 'erase':
                    if (participantId && canParticipantInteract(participantId)) {
                        const radius = data.radius || 30;
                        const x = data.x;
                        const y = data.y;
                        const sectionId = getParticipantSectionId(participantId);

                        if (THE_ROOM.sessionPhase === 'open') {
                            THE_ROOM.drawings = THE_ROOM.drawings.filter(d => {
                                const shouldErase = d.paths.some(p => {
                                    const dist = Math.sqrt(Math.pow(p.x - x, 2) + Math.pow(p.y - y, 2));
                                    return dist < radius;
                                });
                                return !shouldErase;
                            });
                            THE_ROOM.texts = THE_ROOM.texts.filter(t => {
                                const dist = Math.sqrt(Math.pow(t.x - x, 2) + Math.pow(t.y - y, 2));
                                return dist >= radius;
                            });
                        } else {
                            THE_ROOM.drawings = THE_ROOM.drawings.filter(d => {
                                if (d.sectionId !== sectionId) return true;
                                const shouldErase = d.paths.some(p => {
                                    const dist = Math.sqrt(Math.pow(p.x - x, 2) + Math.pow(p.y - y, 2));
                                    return dist < radius;
                                });
                                return !shouldErase;
                            });
                            THE_ROOM.texts = THE_ROOM.texts.filter(t => {
                                if (t.sectionId !== sectionId) return true;
                                const dist = Math.sqrt(Math.pow(t.x - x, 2) + Math.pow(t.y - y, 2));
                                return dist >= radius;
                            });
                        }

                        broadcastToAll({
                            type: 'erased',
                            number: participantNumber,
                            drawings: THE_ROOM.drawings,
                            texts: THE_ROOM.texts
                        }, ws);
                    }
                    break;

                case 'vote_remove':
                    if (participantId && data.targetId && THE_ROOM.votingRound > 0) {
                        if (!THE_ROOM.votes[data.targetId]) {
                            THE_ROOM.votes[data.targetId] = 0;
                        }
                        THE_ROOM.votes[data.targetId]++;
                        broadcastToAll({
                            type: 'vote_update',
                            targetId: data.targetId,
                            votes: THE_ROOM.votes[data.targetId]
                        });
                        if (THE_ROOM.votes[data.targetId] >= 4) {
                            removeParticipant(data.targetId);
                        }
                    }
                    break;

                case 'request_voting':
                    if (participantId) {
                        THE_ROOM.votingRound = data.round || 1;
                        THE_ROOM.votes = {};
                        broadcastToAll({
                            type: 'voting_started',
                            round: THE_ROOM.votingRound
                        });
                        setTimeout(() => {
                            THE_ROOM.votingRound = 0;
                            broadcastToAll({ type: 'voting_ended' });
                        }, 60000);
                    }
                    break;

                case 'request_sections_phase':
                    if (participantId) {
                        THE_ROOM.sessionPhase = 'sections';
                        const numbers = getAllActiveParticipants()
                            .map(p => p.number)
                            .sort((a, b) => a - b);
                        broadcastToAll({
                            type: 'sections_phase',
                            remainingNumbers: numbers
                        });
                    }
                    break;

                case 'create_section':
                    if (participantId && data.inviteeIds) {
                        const inviter = THE_ROOM.participants.get(participantId);
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
                            const m = THE_ROOM.participants.get(id);
                            if (m && m.ws.readyState === WebSocket.OPEN) {
                                members.push({ id: id, number: m.number });
                            }
                        });
                        const section = { id: sectionId, members: members, locked: false };
                        THE_ROOM.sections.push(section);
                        members.forEach(m => {
                            if (m.id !== participantId) {
                                const mData = THE_ROOM.participants.get(m.id);
                                if (mData && mData.ws.readyState === WebSocket.OPEN) {
                                    mData.ws.send(JSON.stringify({
                                        type: 'section_invitation',
                                        sectionId: sectionId,
                                        inviterNumber: participantNumber,
                                        members: members
                                    }));
                                }
                            }
                        });
                        broadcastToAll({
                            type: 'section_created',
                            section: section
                        }, ws);
                    }
                    break;

                case 'accept_section_invitation':
                    if (participantId && data.sectionId) {
                        const section = THE_ROOM.sections.find(s => s.id === data.sectionId);
                        if (section) {
                            const member = section.members.find(m => m.id === participantId);
                            if (member && !member.accepted) {
                                member.accepted = true;
                                if (section.members.every(m => m.accepted)) {
                                    section.locked = true;
                                    section.members.forEach(m => {
                                        const mData = THE_ROOM.participants.get(m.id);
                                        if (mData && mData.ws.readyState === WebSocket.OPEN) {
                                            mData.ws.send(JSON.stringify({
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
        } catch (err) {
            console.error('[MESSAGE ERROR]', err);
        }
    });

    ws.on('close', () => {
        const participantId = ws._participantId;
        if (participantId && THE_ROOM.participants.has(participantId)) {
            const p = THE_ROOM.participants.get(participantId);
            THE_ROOM.participants.delete(participantId);
            
            // Clean sections
            THE_ROOM.sections.forEach(section => {
                section.members = section.members.filter(m => m.id !== participantId);
                if (section.members.length === 0) {
                    THE_ROOM.sections = THE_ROOM.sections.filter(s => s.id !== section.id);
                }
            });

            broadcastToAll({
                type: 'participant_left',
                participantId: participantId,
                number: p.number
            }, ws);

            console.log(`[LEAVE] Participant #${p.number} left. Active: ${countActiveParticipants()}/${MAX_PARTICIPANTS}`);
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`INTERACTION ATLAS server running on port ${PORT}`);
    console.log(`MAX PARTICIPANTS: ${MAX_PARTICIPANTS}`);
    console.log(`SINGLE ROOM: All users join the same room`);
    console.log(`========================================`);
});
