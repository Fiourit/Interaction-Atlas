# INTERACTION ATLAS

A live social experiment: a shared digital space with minimal rules, where people remain and continue only through their interactions with one another.

## Overview

INTERACTION ATLAS is a collaborative canvas experience where up to 20 participants can draw, write, erase, and interact in real-time within an infinite space. There are no predefined topics, categories, algorithms, rankings, or follower counts. Nothing is promoted or protected by default. Visibility and persistence are shaped entirely by participant behavior.

## Key Features

### Identity System
- **Anonymous Participation**: Each participant is assigned a temporary number from 1 to 20, used only within the session
- **No Names or Profiles**: Identity is limited to action: what participants write, draw, erase, or respond to in real time

### Canvas Interaction
- **Infinite Canvas**: Zoom in/out and pan to explore the shared space spatially
- **Real-time Collaboration**: Draw, write text, erase, and overwrite content together
- **Transparent Actions**: All actions are visible - participant numbers are shown when content is created or erased

### Self-Governance
- **Voting System**: After 20 minutes, a voting phase appears. Participants anonymously vote for individuals they believe do not fit the group. Any participant receiving 4+ votes is removed
- **Three Voting Rounds**: Voting happens at 20, 40, and 60 minutes (1 hour total session)
- **No Traditional Moderation**: Collective authority through voting, no fixed limits on removal

### Private Sections (After 60 Minutes)
After the third voting round, remaining participants may form private sections:
- **Maximum 3 participants per section**
- **Requires mutual consent** from all members
- **Locked to outside interaction** - others can view but cannot write, draw, erase, or interfere
- **Full interaction within sections** - members retain full ability to interact with one another

The system functions like a transparent building with glass-walled rooms. Everyone can see what is happening, but after the initial hour, participation becomes more selective.

## Philosophy

This project explores what happens when we remove:
- Predefined topics and categories
- Algorithms that determine visibility
- Follower counts and status signals
- Ranking and promotion systems
- Traditional moderation and safety nets

What remains is human judgment, collective authority, and the question: Can meaningful communication emerge without structure?

**The goal is not to keep everyone. The goal is to see who chooses to stay—and who others choose to stay with.**

## Quick Start

### Option 1: Standalone (Single User / Demo Mode)

Simply open `interaction-atlas.html` in a web browser. It will work in local mode with simulated participants for demonstration purposes.

**Note**: The full voting and sections features work best in multi-user mode.

### Option 2: Multi-User (Real-time Collaboration)

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Server**:
   ```bash
   npm start
   ```
   The server will run on port 8080 by default (or the PORT environment variable if set).

3. **Open in Browser**:
   - Visit the server URL (e.g., `http://localhost:8080` or your deployed URL)
   - The client will automatically connect to the WebSocket server
   - If running locally, open multiple browser tabs/windows to see real-time collaboration

### Multiple Rooms

The application supports **multiple rooms** simultaneously, each with up to 20 participants:

- **Default Room**: Visit `https://your-app.com/` - joins the "default" room
- **Custom Rooms**: Visit `https://your-app.com/?room=room1` - joins "room1"
- **More Examples**: 
  - `https://your-app.com/?room=room1`
  - `https://your-app.com/?room=room2`
  - `https://your-app.com/?room=my-session`

Each room is completely isolated - participants in different rooms cannot see or interact with each other. The room name is displayed in the top bar if it's not the default room.

## Usage

### Tools

- **Draw**: Click and drag to draw on the canvas
- **Text**: Click anywhere to place text, or double-click to place text at that location
- **Eraser**: Click and drag to erase drawings or text
- **Pan**: Click and drag to move around the canvas

### Controls

- **Zoom In/Out**: Use the +/- buttons or mouse wheel
- **Reset View**: Click the home button (⌂) to reset zoom and position
- **Participants List**: View other participants and their numbers
- **Session Timer**: Shows how long the current session has been active

### Session Timeline

1. **0-20 minutes**: Open canvas phase - all participants can interact freely
2. **20 minutes**: First voting round (1 minute) - participants vote to remove others
3. **21-40 minutes**: Open canvas phase continues
4. **40 minutes**: Second voting round (1 minute)
5. **41-60 minutes**: Open canvas phase continues
6. **60 minutes**: Third voting round (1 minute)
7. **After 60 minutes**: Sections phase - participants can form private sections

### Voting

- Voting phases occur automatically at 20, 40, and 60 minutes
- Each participant can vote for others they believe should be removed
- A participant receiving 4+ votes is immediately removed
- Votes are anonymous and counted per round
- The number of removed participants is determined entirely by voting

### Private Sections

After 60 minutes:
- A list appears showing remaining participant numbers
- Participants can invite others to form private sections
- Each section requires mutual consent from all members
- Maximum 3 participants per section
- Sections are locked - outside participants can view but not interact
- Participants in sections can still interact fully with each other

## Technical Details

- **Client**: Pure HTML/CSS/JavaScript (no external dependencies for standalone mode)
- **Server**: Node.js with WebSocket (ws library)
- **Canvas**: HTML5 Canvas with custom drawing system
- **Real-time Sync**: WebSocket-based synchronization of drawings, text, and actions

## Architecture

The application works in two modes:

1. **Standalone Mode**: Works completely offline with simulated participants for demo purposes
2. **WebSocket Mode**: Connects to a server for real-time multi-user collaboration

When the HTML file loads, it attempts to connect to a WebSocket server. If the connection fails, it automatically falls back to standalone mode.

## Development

### File Structure

```
Codes/1/
├── interaction-atlas.html  # Main client application
├── server.js               # WebSocket server
├── package.json            # Node.js dependencies
└── README.md               # This file
```

### Server Configuration

- Default port: 8080
- Max participants per room: 20
- Room cleanup: Empty rooms are cleaned up after 5 minutes

### Client Configuration

- Canvas: Infinite space with zoom/pan
- Drawing: Real-time path-based drawing
- Text: Position-based text elements
- Eraser: Radius-based erasing (works on drag)

## License

MIT
