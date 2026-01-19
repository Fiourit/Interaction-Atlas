# Interaction Atlas

A live social experience: a shared digital space with minimal rules, where people remain and continue only through their interactions with one another.

## Overview

Interaction Atlas is a real-time collaborative canvas platform where up to 20 participants can interact anonymously on an infinite canvas. The platform features:

- **Anonymous Participation**: Participants are assigned numbers (1-20) with no names, profiles, or accounts
- **Real-time Collaboration**: Draw, write, erase, and interact on a shared infinite canvas
- **Self-Governance**: Voting system where participants vote to remove others (4+ votes = removal)
- **Private Sections**: After voting rounds, participants can form private sections (max 3 members)
- **Time-Limited Sessions**: Each room session lasts up to 4 hours

## Features

### Core Functionality
- Infinite canvas with zoom and pan capabilities
- Real-time drawing, text, and erasing
- Anonymous participation (numbered 1-20)
- Age verification (18+)
- Single room system (no multiple rooms)

### Voting System
- Three voting rounds at 20, 40, and 60 minutes
- Participants vote anonymously for removal
- Anyone with 4+ votes is removed
- After 3rd round, remaining participants can form private sections

### Private Sections
- Maximum 3 participants per section
- Requires mutual consent
- Locked to outside interaction (view-only for others)
- Can be viewed by zooming in but not interacted with

### Room Management
- 4-hour maximum duration per room
- No new members after room starts
- Room closes and resets after 4 hours

## Technology Stack

- **Backend**: Node.js, Express, Socket.io
- **Frontend**: HTML5 Canvas, Vanilla JavaScript
- **Real-time Communication**: WebSockets (Socket.io)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd interaction-atlas
```

2. Install dependencies:
```bash
npm install
```

3. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

The application will be available at `http://localhost:3000`

## Deployment on Render.com

### Prerequisites
- GitHub account with this repository
- Render.com account

### Steps

1. **Push to GitHub**:
   - Create a new repository on GitHub
   - Push this code to your repository

2. **Deploy on Render**:
   - Go to [Render.com](https://render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Configure the service:
     - **Name**: interaction-atlas (or your preferred name)
     - **Environment**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Plan**: Free tier or higher
   - Click "Create Web Service"

3. **Environment Variables** (if needed):
   - `PORT`: Automatically set by Render (default: 3000)
   - Add any other environment variables in the Render dashboard

4. **Access Your Application**:
   - Render will provide a URL like `https://your-app-name.onrender.com`
   - Share this URL with participants

## Usage

1. **Access the Platform**:
   - Navigate to the application URL
   - Verify you are 18+ years old

2. **Join the Room**:
   - You'll be assigned a participant number (1-20)
   - Wait for the room to start (first participant starts the timer)

3. **Interact on Canvas**:
   - **Draw Mode**: Click and drag to draw
   - **Text Mode**: Click to add text
   - **Erase Mode**: Click to erase content
   - **Zoom**: Use mouse wheel to zoom in/out
   - **Pan**: Hold Space + drag, or use middle mouse button

4. **Voting Rounds**:
   - At 20, 40, and 60 minutes, voting modals appear
   - Select participants you believe don't fit the group
   - Submit your vote
   - Participants with 4+ votes are removed

5. **Private Sections** (after 3rd voting round):
   - Click "Create Private Section"
   - Select up to 2 other participants
   - Confirm to create the section
   - Only section members can interact within it

## Project Structure

```
interaction-atlas/
├── server.js          # Express server with Socket.io
├── package.json       # Dependencies and scripts
├── .gitignore        # Git ignore file
├── README.md         # This file
└── public/
    ├── index.html    # Main HTML file
    ├── style.css     # Styles
    └── app.js        # Client-side JavaScript
```

## Important Notes

- **Single Room**: Only one room exists at a time
- **No Re-entry**: Once a room starts, no new participants can join
- **4-Hour Limit**: Rooms automatically close after 4 hours
- **Anonymous**: No user accounts, profiles, or persistent identity
- **Self-Moderated**: The group governs itself through voting

## License

MIT

## Contributing

This is a specific project with defined rules and behavior. Contributions should maintain the core philosophy of minimal structure and self-governance.

