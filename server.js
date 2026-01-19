const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const MAX_PARTICIPANTS = 20;

// Single room state
const room = {
  participants: new Map(), // id -> {ws, number, id, joinedAt}
  drawings: [],
  texts: [],
  votes: new Map(), // targetId -> Set of voterId
  sessionStartTime: null,
  sessionPhase: 'open', // 'open', 'voting', 'sections'
  votingRound: 0,
  sections: [], // {id, members: [participantIds], createdAt}
  availableNumbers: Array.from({length: 20}, (_, i) => i + 1), // 1-20
  waitingQueue: [] // {ws, joinedAt}
};

// Initialize session start time
room.sessionStartTime = Date.now();

// Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Interaction Atlas WebSocket Server Running');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

console.log(`Interaction Atlas Server starting on port ${PORT}`);
console.log(`Maximum capacity: ${MAX_PARTICIPANTS} participants`);

wss.on('connection', (ws) => {
  console.log('New connection attempt');
  
  let participantId = null;
  let assignedNumber = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'join':
          handleJoin(ws, data);
          break;
          
        case 'draw':
          handleDraw(participantId, data);
          break;
          
        case 'draw_update':
          handleDrawUpdate(participantId, data);
          break;
          
        case 'text':
          handleText(participantId, data);
          break;
          
        case 'erase':
          handleErase(participantId, data);
          break;
          
        case 'vote_remove':
          handleVote(participantId, data);
          break;
          
        case 'request_voting':
          // Server controls voting rounds based on timer
          break;
          
        case 'request_sections_phase':
          // Server controls phase transitions
          break;
          
        case 'create_section':
          handleCreateSection(participantId, data);
          break;
          
        case 'invite_to_section':
          handleSectionInvite(participantId, data);
          break;
          
        case 'accept_section_invitation':
          handleAcceptSectionInvite(participantId, data);
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    if (participantId) {
      handleDisconnect(participantId);
    } else {
      // Remove from waiting queue if they were waiting
      room.waitingQueue = room.waitingQueue.filter(w => w.ws !== ws);
    }
  });

  function handleJoin(ws, data) {
    // Check if room is full
    if (room.participants.size >= MAX_PARTICIPANTS) {
      // Add to waiting queue
      const position = room.waitingQueue.length + 1;
      room.waitingQueue.push({ws, joinedAt: Date.now()});
      
      ws.send(JSON.stringify({
        type: 'waiting',
        position: position,
        message: `Room is full (${MAX_PARTICIPANTS}/${MAX_PARTICIPANTS}). You are in position ${position} in the queue.`
      }));
      
      console.log(`Connection added to waiting queue. Position: ${position}`);
      return;
    }

    // Assign a number from available pool
    if (room.availableNumbers.length === 0) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Room is full. No numbers available.'
      }));
      ws.close();
      return;
    }

    // Get the lowest available number
    room.availableNumbers.sort((a, b) => a - b);
    assignedNumber = room.availableNumbers.shift();
    participantId = `participant-${Date.now()}-${Math.random()}`;

    // Add participant to room
    room.participants.set(participantId, {
      ws,
      number: assignedNumber,
      id: participantId,
      joinedAt: Date.now()
    });

    console.log(`Participant joined: #${assignedNumber} (${participantId}). Total: ${room.participants.size}/${MAX_PARTICIPANTS}`);

    // Send welcome message to new participant
    ws.send(JSON.stringify({
      type: 'joined',
      participantId: participantId,
      number: assignedNumber,
      participants: Array.from(room.participants.values()).map(p => ({
        id: p.id,
        number: p.number
      })),
      drawings: room.drawings,
      texts: room.texts,
      sessionPhase: room.sessionPhase,
      votingRound: room.votingRound
    }));

    // Notify all other participants
    broadcastToOthers(participantId, {
      type: 'participant_joined',
      participant: {
        id: participantId,
        number: assignedNumber
      }
    });
  }

  function handleDisconnect(participantId) {
    const participant = room.participants.get(participantId);
    if (!participant) return;

    const number = participant.number;
    
    // Return number to available pool
    room.availableNumbers.push(number);
    room.availableNumbers.sort((a, b) => a - b);
    
    // Remove participant
    room.participants.delete(participantId);
    
    console.log(`Participant left: #${number}. Total: ${room.participants.size}/${MAX_PARTICIPANTS}`);

    // Notify others
    broadcast({
      type: 'participant_left',
      participantId: participantId,
      number: number
    });

    // Check if someone is waiting
    if (room.waitingQueue.length > 0) {
      const waiting = room.waitingQueue.shift();
      // Trigger them to rejoin
      waiting.ws.send(JSON.stringify({
        type: 'spot_available',
        message: 'A spot has opened. Rejoining...'
      }));
      // They will send a new join message
    }
  }

  function handleDraw(participantId, data) {
    const participant = room.participants.get(participantId);
    if (!participant) return;

    const drawing = {
      id: `draw-${Date.now()}-${Math.random()}`,
      number: participant.number,
      color: data.color,
      width: data.width,
      paths: data.paths,
      createdAt: Date.now()
    };

    room.drawings.push(drawing);

    broadcast({
      type: 'drawing',
      drawing: drawing
    });
  }

  function handleDrawUpdate(participantId, data) {
    const participant = room.participants.get(participantId);
    if (!participant) return;

    // Find the most recent drawing by this participant
    const lastDrawing = room.drawings
      .filter(d => d.number === participant.number)
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (lastDrawing && data.paths) {
      lastDrawing.paths.push(...data.paths);
      
      broadcast({
        type: 'drawing',
        drawing: lastDrawing
      });
    }
  }

  function handleText(participantId, data) {
    const participant = room.participants.get(participantId);
    if (!participant) return;

    const text = {
      id: `text-${Date.now()}-${Math.random()}`,
      number: participant.number,
      content: data.content,
      x: data.x,
      y: data.y,
      color: data.color,
      size: data.size,
      createdAt: Date.now()
    };

    room.texts.push(text);

    broadcast({
      type: 'text_added',
      text: text
    });
  }

  function handleErase(participantId, data) {
    const participant = room.participants.get(participantId);
    if (!participant) return;

    const {x, y, radius} = data;
    let erasedCount = 0;

    // Erase drawings within radius
    room.drawings = room.drawings.filter(drawing => {
      const shouldErase = drawing.paths.some(path => {
        const dist = Math.sqrt(Math.pow(path.x - x, 2) + Math.pow(path.y - y, 2));
        return dist < radius;
      });
      if (shouldErase) erasedCount++;
      return !shouldErase;
    });

    // Erase texts within radius
    room.texts = room.texts.filter(text => {
      const dist = Math.sqrt(Math.pow(text.x - x, 2) + Math.pow(text.y - y, 2));
      if (dist < radius) erasedCount++;
      return dist >= radius;
    });

    if (erasedCount > 0) {
      broadcast({
        type: 'erased',
        number: participant.number,
        drawings: room.drawings,
        texts: room.texts
      });
    }
  }

  function handleVote(participantId, data) {
    if (room.sessionPhase !== 'voting') return;

    const targetId = data.targetId;
    if (!room.participants.has(targetId)) return;

    // Initialize vote set for target if needed
    if (!room.votes.has(targetId)) {
      room.votes.set(targetId, new Set());
    }

    // Add vote
    room.votes.get(targetId).add(participantId);
    const voteCount = room.votes.get(targetId).size;

    // Broadcast vote update
    broadcast({
      type: 'vote_update',
      targetId: targetId,
      votes: voteCount
    });

    // Remove participant if they have 4+ votes
    if (voteCount >= 4) {
      removeParticipant(targetId);
    }
  }

  function removeParticipant(participantId) {
    const participant = room.participants.get(participantId);
    if (!participant) return;

    const number = participant.number;

    // Close their connection
    participant.ws.close();

    // Return number to pool
    room.availableNumbers.push(number);
    room.participants.delete(participantId);

    console.log(`Participant removed by vote: #${number}`);

    broadcast({
      type: 'participant_removed',
      participantId: participantId,
      number: number
    });
  }

  function handleCreateSection(participantId, data) {
    if (room.sessionPhase !== 'sections') return;

    const section = {
      id: `section-${Date.now()}-${Math.random()}`,
      members: [participantId],
      createdAt: Date.now()
    };

    room.sections.push(section);

    broadcast({
      type: 'section_created',
      section: {
        id: section.id,
        members: section.members.map(id => ({
          id,
          number: room.participants.get(id)?.number
        }))
      }
    });
  }

  function handleSectionInvite(participantId, data) {
    if (room.sessionPhase !== 'sections') return;

    const targetId = data.targetId;
    const sectionId = data.sectionId;

    const target = room.participants.get(targetId);
    const inviter = room.participants.get(participantId);

    if (target && inviter) {
      target.ws.send(JSON.stringify({
        type: 'section_invitation',
        sectionId: sectionId,
        inviterId: participantId,
        inviterNumber: inviter.number
      }));
    }
  }

  function handleAcceptSectionInvite(participantId, data) {
    const section = room.sections.find(s => s.id === data.sectionId);
    if (!section) return;

    if (section.members.length >= 3) return; // Max 3 members

    section.members.push(participantId);

    broadcast({
      type: 'section_joined',
      sectionId: section.id,
      participantId: participantId
    });
  }

  function broadcast(message) {
    const messageStr = JSON.stringify(message);
    room.participants.forEach(participant => {
      if (participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(messageStr);
      }
    });
  }

  function broadcastToOthers(excludeId, message) {
    const messageStr = JSON.stringify(message);
    room.participants.forEach((participant, id) => {
      if (id !== excludeId && participant.ws.readyState === WebSocket.OPEN) {
        participant.ws.send(messageStr);
      }
    });
  }
});

// Voting rounds timer (20, 40, 60 minutes)
setInterval(() => {
  const elapsed = Date.now() - room.sessionStartTime;
  const minutes = Math.floor(elapsed / 60000);

  if (minutes === 20 && room.votingRound === 0) {
    startVotingRound(1);
  } else if (minutes === 40 && room.votingRound === 1) {
    startVotingRound(2);
  } else if (minutes === 60 && room.votingRound === 2) {
    startVotingRound(3);
    // Transition to sections phase after 1 minute of voting
    setTimeout(() => {
      enterSectionsPhase();
    }, 60000);
  }
}, 10000); // Check every 10 seconds

function startVotingRound(round) {
  room.sessionPhase = 'voting';
  room.votingRound = round;
  room.votes.clear();

  console.log(`Starting voting round ${round}`);

  broadcast({
    type: 'voting_started',
    round: round
  });

  // End voting after 1 minute
  setTimeout(() => {
    room.sessionPhase = 'open';
    broadcast({
      type: 'voting_ended',
      round: round
    });
  }, 60000);
}

function enterSectionsPhase() {
  room.sessionPhase = 'sections';
  
  console.log('Entering sections phase');

  broadcast({
    type: 'sections_phase',
    remainingParticipants: Array.from(room.participants.values()).map(p => ({
      id: p.id,
      number: p.number
    }))
  });
}

function broadcast(message) {
  const messageStr = JSON.stringify(message);
  room.participants.forEach(participant => {
    if (participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.send(messageStr);
    }
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`Interaction Atlas Server running on port ${PORT}`);
  console.log(`Maximum capacity: ${MAX_PARTICIPANTS} participants`);
  console.log(`Session started at: ${new Date(room.sessionStartTime).toISOString()}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});