const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Room state management
class Room {
  constructor() {
    this.participants = new Map(); // socketId -> participant data
    this.canvasData = []; // All canvas elements
    this.privateSections = new Map(); // sectionId -> {members: Set, locked: true}
    this.votingRounds = 0; // 0, 1, 2, 3
    this.votingPhase = false;
    this.votes = new Map(); // socketId -> Set of voted socketIds
    this.startTime = null;
    this.roomActive = false;
    this.availableNumbers = new Set([...Array(20).keys()].map(i => i + 1));
    this.nextNumber = 1;
  }

  addParticipant(socketId, ageVerified) {
    if (!ageVerified) {
      return null;
    }

    if (this.participants.size >= 20) {
      return null; // Room full
    }

    // Allow people to join until the first voting round starts (20 minutes)
    // After that, no new members can join
    if (this.roomActive && this.startTime && this.votingRounds > 0) {
      // First voting round has started, no new members
      return null;
    }

    const number = this.availableNumbers.size > 0 
      ? Array.from(this.availableNumbers)[0] 
      : this.nextNumber++;
    
    if (this.availableNumbers.has(number)) {
      this.availableNumbers.delete(number);
    }

    const participant = {
      socketId,
      number,
      joinedAt: Date.now(),
      inPrivateSection: null,
      currentPath: null
    };

    this.participants.set(socketId, participant);
    
    // Start room timer if first participant
    if (!this.roomActive && this.participants.size === 1) {
      this.startRoom();
    }

    return participant;
  }

  removeParticipant(socketId) {
    const participant = this.participants.get(socketId);
    if (!participant) return;

    // Remove from private section if in one
    if (participant.inPrivateSection) {
      this.leavePrivateSection(socketId, participant.inPrivateSection);
    }

    // Free up the number
    this.availableNumbers.add(participant.number);

    this.participants.delete(socketId);
    this.votes.delete(socketId);
  }

  startRoom() {
    this.roomActive = true;
    this.startTime = Date.now();
    
    // Schedule voting rounds at 20, 40, 60 minutes
    setTimeout(() => this.startVotingRound(1), 20 * 60 * 1000);
    setTimeout(() => this.startVotingRound(2), 40 * 60 * 1000);
    setTimeout(() => this.startVotingRound(3), 60 * 60 * 1000);
    
    // Close room after 4 hours
    setTimeout(() => this.closeRoom(), 4 * 60 * 60 * 1000);
  }

  startVotingRound(round) {
    if (round > 3) return;
    
    this.votingRounds = round;
    this.votingPhase = true;
    this.votes.clear();
    
    io.emit('votingStarted', { round });
    
    // End voting after 2 minutes
    setTimeout(() => this.endVotingRound(), 2 * 60 * 1000);
  }

  endVotingRound() {
    this.votingPhase = false;
    
    // Count votes
    const voteCounts = new Map();
    this.votes.forEach((votedSet, voterId) => {
      votedSet.forEach(votedId => {
        voteCounts.set(votedId, (voteCounts.get(votedId) || 0) + 1);
      });
    });

    // Remove participants with 4+ votes
    const removed = [];
    voteCounts.forEach((count, socketId) => {
      if (count >= 4) {
        const participant = this.participants.get(socketId);
        if (participant) {
          removed.push(participant.number);
          this.removeParticipant(socketId);
          io.to(socketId).emit('removed', { reason: 'voted_out' });
        }
      }
    });

    io.emit('votingEnded', { 
      round: this.votingRounds,
      removed: removed 
    });

    // After 3rd round, show remaining participants
    if (this.votingRounds === 3) {
      const remaining = Array.from(this.participants.values()).map(p => p.number);
      io.emit('votingComplete', { remaining });
    }
  }

  submitVote(voterId, votedNumbers) {
    if (!this.votingPhase) return false;
    
    const voter = this.participants.get(voterId);
    if (!voter) return false;

    // Find socketIds for voted numbers
    const votedSocketIds = new Set();
    this.participants.forEach((participant, socketId) => {
      if (votedNumbers.includes(participant.number) && socketId !== voterId) {
        votedSocketIds.add(socketId);
      }
    });

    this.votes.set(voterId, votedSocketIds);
    return true;
  }

  createPrivateSection(creatorId, inviteeNumbers) {
    const creator = this.participants.get(creatorId);
    if (!creator || creator.inPrivateSection) return null;

    if (inviteeNumbers.length > 2) return null; // Max 3 total (creator + 2)

    // Find invitees
    const invitees = [];
    this.participants.forEach((participant, socketId) => {
      if (inviteeNumbers.includes(participant.number) && 
          !participant.inPrivateSection && 
          socketId !== creatorId) {
        invitees.push({ socketId, participant });
      }
    });

    if (invitees.length !== inviteeNumbers.length) return null;

    const sectionId = `section_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const members = new Set([creatorId, ...invitees.map(i => i.socketId)]);
    
    this.privateSections.set(sectionId, {
      members,
      locked: true,
      createdAt: Date.now()
    });

    // Update participants
    creator.inPrivateSection = sectionId;
    invitees.forEach(invitee => {
      invitee.participant.inPrivateSection = sectionId;
    });

    return { sectionId, members: Array.from(members) };
  }

  leavePrivateSection(socketId, sectionId) {
    const section = this.privateSections.get(sectionId);
    if (!section) return;

    section.members.delete(socketId);
    const participant = this.participants.get(socketId);
    if (participant) {
      participant.inPrivateSection = null;
    }

    if (section.members.size === 0) {
      this.privateSections.delete(sectionId);
    }
  }

  canInteract(socketId, targetSocketId) {
    const participant = this.participants.get(socketId);
    const target = this.participants.get(targetSocketId);
    
    if (!participant || !target) return false;

    // If both in same private section, allow
    if (participant.inPrivateSection && 
        participant.inPrivateSection === target.inPrivateSection) {
      return true;
    }

    // If neither in private section, allow
    if (!participant.inPrivateSection && !target.inPrivateSection) {
      return true;
    }

    // Otherwise, one is in private section and other isn't - block
    return false;
  }

  closeRoom() {
    this.roomActive = false;
    io.emit('roomClosed');
    
    // Clear everything after a delay
    setTimeout(() => {
      this.participants.clear();
      this.canvasData = [];
      this.privateSections.clear();
      this.votingRounds = 0;
      this.votingPhase = false;
      this.votes.clear();
      this.startTime = null;
      this.availableNumbers = new Set([...Array(20).keys()].map(i => i + 1));
      this.nextNumber = 1;
    }, 5000);
  }

  getRoomState() {
    return {
      participants: Array.from(this.participants.values()).map(p => ({
        number: p.number,
        inPrivateSection: p.inPrivateSection
      })),
      votingPhase: this.votingPhase,
      votingRound: this.votingRounds,
      roomActive: this.roomActive,
      timeElapsed: this.startTime ? Date.now() - this.startTime : 0
    };
  }

  getParticipantsForVoting(excludeSocketId) {
    return Array.from(this.participants.values())
      .filter(p => p.socketId !== excludeSocketId)
      .map(p => ({
        number: p.number,
        socketId: p.socketId
      }));
  }
}

const room = new Room();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', ({ ageVerified }) => {
    const participant = room.addParticipant(socket.id, ageVerified);
    
    if (!participant) {
      socket.emit('joinFailed', { 
        reason: ageVerified ? 'room_full_or_started' : 'age_verification_failed' 
      });
      return;
    }

    socket.emit('joined', {
      number: participant.number,
      roomState: room.getRoomState(),
      canvasData: room.canvasData
    });

    // Notify others
    socket.broadcast.emit('participantJoined', {
      number: participant.number
    });
  });

  socket.on('canvasAction', (action) => {
    const participant = room.participants.get(socket.id);
    if (!participant) return;

    // Add timestamp and participant info
    action.timestamp = Date.now();
    action.participantNumber = participant.number;
    if (!action.id) {
      action.id = `${socket.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Store complete paths for drawing
    if (action.type === 'draw' && action.pathId) {
      let pathItem = room.canvasData.find(item => item.pathId === action.pathId && item.participantNumber === participant.number);
      
      if (!pathItem) {
        // First point of path - create new path item
        pathItem = {
          ...action,
          pathPoints: [{ x: action.x, y: action.y }]
        };
        room.canvasData.push(pathItem);
      } else {
        // Update existing path
        if (!pathItem.pathPoints) {
          pathItem.pathPoints = [];
        }
        pathItem.pathPoints.push({ x: action.x, y: action.y });
      }
    } else if (action.type === 'text') {
      // Text items are complete, just add them
      room.canvasData.push(action);
    }
    
    // Broadcast to all (they'll filter based on private sections on client)
    io.emit('canvasUpdate', action);
  });

  socket.on('erase', (data) => {
    const participant = room.participants.get(socket.id);
    if (!participant) return;

    const eraseRadius = data.eraseRadius || 20;
    const itemsToRemove = [];

    // Find items to remove
    room.canvasData.forEach((item, index) => {
      if (item.type === 'text') {
        // For text, check if eraser is near the text position
        const distance = Math.sqrt(Math.pow(item.x - data.x, 2) + Math.pow(item.y - data.y, 2));
        if (distance < eraseRadius) {
          itemsToRemove.push(index);
        }
      } else if (item.type === 'draw' && item.pathId) {
        // For paths, check if eraser is near any point in the path
        if (item.pathPoints && item.pathPoints.length > 0) {
          for (let i = 0; i < item.pathPoints.length; i++) {
            const distance = Math.sqrt(Math.pow(item.pathPoints[i].x - data.x, 2) + Math.pow(item.pathPoints[i].y - data.y, 2));
            if (distance < eraseRadius) {
              itemsToRemove.push(index);
              break;
            }
          }
        }
      }
    });

    // Remove items in reverse order to maintain indices
    itemsToRemove.reverse().forEach(index => {
      room.canvasData.splice(index, 1);
    });

    if (itemsToRemove.length > 0) {
      io.emit('canvasErase', { ...data, eraseRadius });
    }
  });

  socket.on('vote', ({ votedNumbers }) => {
    const success = room.submitVote(socket.id, votedNumbers);
    socket.emit('voteSubmitted', { success });
  });

  socket.on('createPrivateSection', ({ inviteeNumbers }, callback) => {
    const section = room.createPrivateSection(socket.id, inviteeNumbers);
    if (section) {
      // Notify all members
      section.members.forEach(memberId => {
        io.to(memberId).emit('privateSectionCreated', {
          sectionId: section.sectionId,
          members: section.members.map(id => {
            const p = room.participants.get(id);
            return p ? p.number : null;
          }).filter(n => n !== null)
        });
      });
      
      callback({ success: true, sectionId: section.sectionId });
    } else {
      callback({ success: false });
    }
  });

  socket.on('getParticipants', (data, callback) => {
    const participants = Array.from(room.participants.values()).map(p => ({
      number: p.number,
      inPrivateSection: p.inPrivateSection
    }));
    callback(participants);
  });

  socket.on('getAvailableParticipants', (data, callback) => {
    const participants = Array.from(room.participants.values())
      .filter(p => p.socketId !== socket.id && !p.inPrivateSection)
      .map(p => ({
        number: p.number,
        inPrivateSection: p.inPrivateSection
      }));
    callback(participants);
  });

  socket.on('getParticipantCount', (data, callback) => {
    callback(room.participants.size);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const participant = room.participants.get(socket.id);
    if (participant) {
      room.removeParticipant(socket.id);
      socket.broadcast.emit('participantLeft', {
        number: participant.number
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

