# Deployment Guide for INTERACTION ATLAS

This guide will help you deploy INTERACTION ATLAS so others can participate in real-time.

## ⚠️ Important: GitHub Pages Won't Work

GitHub Pages only serves static files (HTML/CSS/JS). This application needs a **Node.js server** running for WebSocket connections. You must deploy to a hosting service that supports Node.js.

## 🚀 Recommended: Render.com (Free Tier Available)

**Render** is easy to use and offers a free tier perfect for this project.

### Step 1: Prepare Your Repository

1. **Push your code to GitHub** (as you mentioned you know how to do this)
   - Make sure all files are in the `Codes/1/` directory
   - Files needed: `server.js`, `package.json`, `interaction-atlas.html`

### Step 2: Deploy on Render

1. **Sign up** at [render.com](https://render.com) (free account)

2. **Create a new Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Select the repository with your code

3. **Configure the service**:
   - **Name**: `interaction-atlas` (or any name you like)
   - **Root Directory**: `Codes/1` (or leave blank if files are in root)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (or paid if you need more resources)

4. **Click "Create Web Service"**

5. **Wait for deployment** (usually 2-3 minutes)

6. **Your app will be live at**: `https://your-app-name.onrender.com`

### Step 3: Test It

1. Open the URL in your browser - you should see the INTERACTION ATLAS interface
2. Open the same URL in another browser tab/window to test real-time collaboration
3. Share the URL with others to participate together!

---

## 🔄 Alternative: Railway.app (Also Free Tier)

**Railway** is another excellent option with similar setup:

1. Sign up at [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Set root directory to `Codes/1` if needed
5. Railway auto-detects Node.js and runs `npm install` + `npm start`
6. Your app will be live with a generated URL

---

## 🌐 Alternative: Fly.io (Free Tier)

1. Sign up at [fly.io](https://fly.io)
2. Install Fly CLI: `npm install -g flyctl`
3. Run `fly launch` in your `Codes/1` directory
4. Follow the prompts
5. Your app will be deployed

---

## 🏠 Self-Hosting (VPS/Cloud Server)

If you have your own server:

1. **SSH into your server**
2. **Clone your repository**:
   ```bash
   git clone https://github.com/your-username/your-repo.git
   cd your-repo/Codes/1
   ```

3. **Install Node.js** (if not already installed):
   ```bash
   # On Ubuntu/Debian:
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

4. **Install dependencies**:
   ```bash
   npm install
   ```

5. **Run with PM2** (recommended for production):
   ```bash
   npm install -g pm2
   pm2 start server.js --name interaction-atlas
   pm2 save
   pm2 startup
   ```

6. **Set up reverse proxy** (nginx example):
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://localhost:8080;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

---

## 📝 Environment Variables (Optional)

If you need to customize the port, some hosting services let you set:
- `PORT` environment variable (defaults to 8080)

---

## ✅ What Happens After Deployment?

1. **Single URL**: Users visit one URL (e.g., `https://your-app.onrender.com`)
2. **Automatic Connection**: The HTML file automatically connects to the WebSocket server
3. **Real-time Collaboration**: All participants see each other's actions in real-time
4. **Session Management**: The server handles rooms, participants, voting, and sections

---

## 🐛 Troubleshooting

### Connection Issues
- Make sure your hosting service supports WebSocket connections
- Render, Railway, and Fly.io all support WebSockets by default

### Port Issues
- The server uses `process.env.PORT` which hosting services set automatically
- Don't hardcode port numbers in production

### File Not Found
- Make sure `interaction-atlas.html` is in the same directory as `server.js`
- Check the root directory setting in your hosting service

---

## 🎉 You're Done!

Once deployed, share the URL with others and start collaborating! The application supports up to 20 participants per session.
