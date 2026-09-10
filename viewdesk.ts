import express from "express";
import http from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { mouse, keyboard, Button, Key } from "@nut-tree-fork/nut-js";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// ==========================================
// 1. UAC / DOMAIN ADMIN ELEVATION CHECK
// ==========================================
function ensureAdminPrivileges(): void {
  if (process.platform === "win32") {
    try {
      execSync("net session", { stdio: "ignore" });
      console.log("[ViewDesk Security] Running with FULL Administrative Privileges.");
    } catch {
      console.warn("[ViewDesk Warning] Running without elevated privileges. Some administrative OS functions may be restricted.");
    }
  }
}

ensureAdminPrivileges();

// ==========================================
// 2. HARDWARE-BOUND ID & 7-CHAR PASSWORD GENERATOR
// ==========================================
function getHardwareUniqueId(): string {
  try {
    const interfaces = os.networkInterfaces();
    let macAddress = "";

    for (const name of Object.keys(interfaces)) {
      const networkInterface = interfaces[name];
      if (networkInterface) {
        for (const net of networkInterface) {
          if (!net.internal && net.mac && net.mac !== "00:00:00:00:00:00") {
            macAddress = net.mac;
            break;
          }
        }
      }
      if (macAddress) break;
    }

    if (!macAddress) macAddress = os.hostname();

    let hash = 0;
    for (let i = 0; i < macAddress.length; i++) {
      hash = (hash << 5) - hash + macAddress.charCodeAt(i);
      hash |= 0;
    }
    
    const absHash = Math.abs(hash).toString().padStart(9, "7");
    return `${absHash.substring(0, 3)}-${absHash.substring(3, 6)}-${absHash.substring(6, 9)}`;
  } catch {
    return "123-456-789";
  }
}

// Generate dynamic 7-character password mixing A-Z, a-z, 0-9
function generateSessionPassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let password = "";
  for (let i = 0; i < 7; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

const PC_VIEWDESK_ID = getHardwareUniqueId();
const PC_SESSION_PASSWORD = generateSessionPassword();

// ==========================================
// 3. CONFIGURATION & TYPES
// ==========================================
const PORT = process.env.PORT || 3000;
const DEVELOPER_NAME = "nishildennis";

interface InputEvent {
  type: "mousemove" | "mousedown" | "mouseup" | "keydown" | "keyup";
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  key?: string;
}

interface FileOperation {
  action: "list" | "delete" | "upload";
  dirPath?: string;
  filePath?: string;
  fileName?: string;
  fileBufferBase64?: string;
}

const activeClientsByViewdeskId = new Map<string, string>(); 
const viewdeskIdsBySocketId = new Map<string, string>();     
const passwordsByViewdeskId = new Map<string, string>(); 
const activeSessions = new Map<string, { hostViewdeskId: string; guestViewdeskId: string }>();

// ==========================================
// 4. NATIVE INPUT & FILE SYSTEM ENGINE
// ==========================================
class DeviceController {
  public static async executeInput(event: InputEvent): Promise<void> {
    try {
      switch (event.type) {
        case "mousemove":
          if (event.x !== undefined && event.y !== undefined) {
            await mouse.setPosition({ x: event.x, y: event.y });
          }
          break;

        case "mousedown":
          if (event.button === "right") await mouse.pressButton(Button.RIGHT);
          else await mouse.pressButton(Button.LEFT);
          break;

        case "mouseup":
          if (event.button === "right") await mouse.releaseButton(Button.RIGHT);
          else await mouse.releaseButton(Button.LEFT);
          break;

        case "keydown":
          if (event.key) {
            const keyEnum = DeviceController.mapKey(event.key);
            if (keyEnum !== null) await keyboard.pressKey(keyEnum);
          }
          break;

        case "keyup":
          if (event.key) {
            const keyEnum = DeviceController.mapKey(event.key);
            if (keyEnum !== null) await keyboard.releaseKey(keyEnum);
          }
          break;
      }
    } catch (err) {
      console.error("[DeviceController] Input execution error:", err);
    }
  }

  public static handleFileOperation(op: FileOperation): any {
    try {
      if (op.action === "list" && op.dirPath) {
        return { success: true, files: fs.readdirSync(op.dirPath) };
      }
      if (op.action === "delete" && op.filePath) {
        fs.unlinkSync(op.filePath);
        return { success: true, message: `File ${op.filePath} deleted successfully.` };
      }
      if (op.action === "upload" && op.dirPath && op.fileName && op.fileBufferBase64) {
        const fullPath = path.join(op.dirPath, op.fileName);
        fs.writeFileSync(fullPath, Buffer.from(op.fileBufferBase64, "base64"));
        return { success: true, message: `File uploaded to ${fullPath}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private static mapKey(key: string): Key | null {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "enter") return Key.Return;
    if (lowerKey === "backspace") return Key.Backspace;
    if (lowerKey === "tab") return Key.Tab;
    if (lowerKey === "escape") return Key.Escape;
    if (lowerKey === "space") return Key.Space;
    return null;
  }
}

// ==========================================
// 5. EXPRESS APP & LAYOUT WITH TOP DASHBOARD
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: "*" } });

app.get("/", (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ViewDesk - Your Window to Remote Productivity</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 0; }
    
    .header { background: #1e293b; padding: 18px 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #ef4444; }
    .brand { font-size: 1.5rem; font-weight: bold; color: #ffffff; display: flex; align-items: center; gap: 12px; }
    .brand-accent { color: #ef4444; }
    .logo-icon { width: 32px; height: 32px; fill: none; stroke: #ef4444; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .admin-badge { background: #10b981; color: #000; font-size: 0.75rem; font-weight: bold; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; }

    .main-container { max-width: 1100px; margin: 25px auto; padding: 0 20px; }

    .dashboard { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 30px; }
    .card { background: #1e293b; border-radius: 12px; padding: 28px; border: 1px solid #334155; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    .card h2 { margin-top: 0; font-size: 1.1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }

    .id-display { background: #0f172a; padding: 16px; border-radius: 8px; border: 1px solid #334155; text-align: center; margin: 15px 0 10px 0; }
    .id-number { font-size: 2.2rem; font-weight: bold; letter-spacing: 3px; color: #10b981; font-family: monospace; }
    
    .password-box { background: #0f172a; padding: 10px 15px; border-radius: 6px; border: 1px dashed #ef4444; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .password-title { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; }
    .password-val { font-size: 1.4rem; font-weight: bold; color: #ef4444; font-family: monospace; letter-spacing: 2px; }

    input[type="text"], input[type="password"] { width: 100%; padding: 14px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 1.2rem; text-align: center; font-family: monospace; letter-spacing: 2px; margin: 12px 0; outline: none; }
    input:focus { border-color: #ef4444; }

    button { width: 100%; padding: 14px; border-radius: 8px; border: none; font-size: 1rem; font-weight: bold; cursor: pointer; transition: background 0.2s; background: #ef4444; color: #fff; }
    button:hover { background: #dc2626; }

    .welcome-card { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 12px; padding: 30px; border: 1px solid #334155; text-align: center; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    .slogan { font-size: 1.3rem; font-weight: 600; color: #ef4444; margin: 8px 0 16px 0; font-style: italic; }
    .welcome-text { font-size: 0.98rem; color: #94a3b8; line-height: 1.6; max-width: 900px; margin: 0 auto; }

    .features-title { font-size: 1.1rem; text-transform: uppercase; letter-spacing: 1px; color: #f8fafc; margin-top: 25px; margin-bottom: 15px; font-weight: bold; }
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; text-align: left; margin-top: 15px; }
    .feature-item { background: #0f172a; padding: 12px 16px; border-radius: 8px; border: 1px solid #334155; font-size: 0.9rem; color: #cbd5e1; display: flex; align-items: center; gap: 10px; }
    .feature-item::before { content: "✓"; color: #10b981; font-weight: bold; }

    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 1000; justify-content: center; align-items: center; }
    .modal-card { background: #1e293b; width: 420px; padding: 30px; border-radius: 12px; text-align: center; border: 2px solid #ef4444; }

    #viewer-container { display: none; width: 100vw; height: 100vh; background: #000; position: fixed; top: 0; left: 0; z-index: 999; }
    #admin-toolbar { position: absolute; top: 15px; left: 50%; transform: translateX(-50%); z-index: 1002; background: #1e293b; padding: 10px 20px; border-radius: 8px; display: flex; gap: 10px; border: 1px solid #ef4444; }
    #admin-toolbar button { width: auto; padding: 8px 15px; font-size: 0.85rem; background: #334155; }
    #admin-toolbar button:hover { background: #ef4444; }
    #remote-video { width: 100%; height: 100%; object-fit: contain; outline: none; }

    .footer { text-align: center; margin-top: 50px; padding: 20px; color: #64748b; font-size: 0.85rem; border-top: 1px solid #1e293b; }
  </style>
</head>
<body>

  <div class="header">
    <div class="brand">
      <svg class="logo-icon" viewBox="0 0 24 24">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
        <polyline points="7 10 10 7 13 10"></polyline>
        <line x1="10" y1="7" x2="10" y2="14"></line>
      </svg>
      <div><span class="brand-accent">View</span>Desk</div>
      <span class="admin-badge">Secure Access</span>
    </div>
    <div style="color: #10b981; font-size: 0.9rem;">● Cloud Signaling Active</div>
  </div>

  <div class="main-container">
    <div class="dashboard">
      <div class="card">
        <h2>This Desk</h2>
        <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0;">Share this ID & Password to grant remote access.</p>
        
        <div class="id-display"><div id="my-viewdesk-id" class="id-number">${PC_VIEWDESK_ID}</div></div>
        
        <div class="password-box">
          <span class="password-title">One-Time Password:</span>
          <span class="password-val" id="my-password">${PC_SESSION_PASSWORD}</span>
        </div>

        <p style="font-size: 0.75rem; color: #64748b; text-align: center; margin-top: 5px;">Password resets on app restart</p>
      </div>

      <div class="card">
        <h2>Remote Desk</h2>
        <p style="color: #94a3b8; font-size: 0.85rem;">Enter the ViewDesk ID of the target device.</p>
        <input type="text" id="target-id" placeholder="000-000-000" maxlength="11" />
        <button onclick="openPasswordPrompt()">Full Access Connect</button>
      </div>
    </div>

    <div class="welcome-card">
      <h1 style="margin: 0; font-size: 1.8rem; color: #ffffff;">Welcome to ViewDesk</h1>
      <div class="slogan">"ViewDesk - Your Window to Remote Productivity."</div>
      <p class="welcome-text">
        In today's connected world, accessing your devices remotely is essential. ViewDesk enables secure desktop screen access and control from anywhere, helping individuals and businesses stay productive.
      </p>

      <div class="features-title">Key Features</div>
      <div class="features-grid">
        <div class="feature-item">Secure Remote Desktop Access</div>
        <div class="feature-item">Real-Time Screen Viewing</div>
        <div class="feature-item">Fast and Stable Connections</div>
        <div class="feature-item">Multi-Device Support</div>
        <div class="feature-item">Remote Technical Assistance</div>
        <div class="feature-item">Enterprise-Grade Security</div>
        <div class="feature-item">Easy Device Management</div>
        <div class="feature-item">Seamless Team Collaboration</div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="password-modal">
    <div class="modal-card">
      <h2 style="margin-top:0;">Authentication Required</h2>
      <p style="color: #94a3b8; font-size: 0.9rem;">Enter the 7-character password shown on the target desk:</p>
      <input type="password" id="input-password" placeholder="*******" maxlength="7" />
      <div style="display: flex; gap: 10px; margin-top: 15px;">
        <button style="background: #10b981;" onclick="submitPasswordConnect()">Connect</button>
        <button style="background: #f43f5e;" onclick="closePasswordModal()">Cancel</button>
      </div>
    </div>
  </div>

  <div id="viewer-container">
    <div id="admin-toolbar">
      <button onclick="deleteRemoteFile()">Delete Remote File</button>
      <button style="background: #f43f5e;" onclick="endSession()">Disconnect</button>
    </div>
    <video id="remote-video" autoplay playsinline tabindex="0"></video>
  </div>

  <div class="footer">
    ViewDesk Remote Access &bull; Developed by <strong>${DEVELOPER_NAME}</strong>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    // LIVE RENDER SIGNALING ENDPOINT
    const CLOUD_URL = "https://viewdesk-server.onrender.com"; 
    const SOCKET_URL = window.location.hostname === "localhost" ? "http://localhost:3000" : CLOUD_URL;

    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      secure: true
    });

    const myViewDeskId = "${PC_VIEWDESK_ID}";
    const myPassword = "${PC_SESSION_PASSWORD}";
    let pc = null;
    let localStream = null;
    let currentRequesterId = null;

    const rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    socket.on('connect', () => {
      socket.emit('register_device', { viewdeskId: myViewDeskId, password: myPassword });
    });

    function openPasswordPrompt() {
      const targetId = document.getElementById('target-id').value.trim();
      if (!targetId) return alert("Please enter a target ViewDesk ID");
      if (targetId === myViewDeskId) return alert("Cannot connect to self ID");

      document.getElementById('password-modal').style.display = 'flex';
    }

    function closePasswordModal() {
      document.getElementById('password-modal').style.display = 'none';
      document.getElementById('input-password').value = '';
    }

    function submitPasswordConnect() {
      const targetId = document.getElementById('target-id').value.trim();
      const enteredPassword = document.getElementById('input-password').value.trim();

      if (!enteredPassword) return alert("Please enter the password");

      closePasswordModal();
      socket.emit('request_session_auth', { targetViewdeskId: targetId, password: enteredPassword });
    }

    socket.on('auth_success', ({ hostViewdeskId }) => {
      setupGuestWebRTC(hostViewdeskId);
    });

    socket.on('auth_failed', ({ message }) => {
      alert("Authentication Failed: " + message);
    });

    socket.on('incoming_authenticated_session', async ({ requesterViewdeskId }) => {
      currentRequesterId = requesterViewdeskId;
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        pc = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

        pc.onicecandidate = (e) => {
          if (e.candidate) socket.emit('webrtc_signal', { targetViewdeskId: currentRequesterId, signal: { candidate: e.candidate } });
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_signal', { targetViewdeskId: currentRequesterId, signal: { sdp: pc.localDescription } });

        localStream.getVideoTracks()[0].onended = () => endSession();
      } catch (err) {
        console.error("Screen capture failed:", err);
      }
    });

    function setupGuestWebRTC(hostViewdeskId) {
      document.getElementById('viewer-container').style.display = 'block';
      pc = new RTCPeerConnection(rtcConfig);

      pc.ontrack = (e) => {
        if (e.streams && e.streams[0]) {
          document.getElementById('remote-video').srcObject = e.streams[0];
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('webrtc_signal', { targetViewdeskId: hostViewdeskId, signal: { candidate: e.candidate } });
      };

      const video = document.getElementById('remote-video');
      
      video.addEventListener('mousemove', (e) => {
        const rect = video.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) * (video.videoWidth / rect.width));
        const y = Math.round((e.clientY - rect.top) * (video.videoHeight / rect.height));
        socket.emit('input_event', { hostViewdeskId, event: { type: 'mousemove', x, y } });
      });

      video.addEventListener('mousedown', (e) => {
        socket.emit('input_event', { hostViewdeskId, event: { type: 'mousedown', button: e.button === 2 ? 'right' : 'left' } });
      });

      video.addEventListener('mouseup', (e) => {
        socket.emit('input_event', { hostViewdeskId, event: { type: 'mouseup', button: e.button === 2 ? 'right' : 'left' } });
      });

      window.addEventListener('keydown', (e) => {
        socket.emit('input_event', { hostViewdeskId, event: { type: 'keydown', key: e.key } });
      });

      window.addEventListener('keyup', (e) => {
        socket.emit('input_event', { hostViewdeskId, event: { type: 'keyup', key: e.key } });
      });
    }

    socket.on('webrtc_signal', async ({ senderViewdeskId, signal }) => {
      if (!pc) return;
      if (signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('webrtc_signal', { targetViewdeskId: senderViewdeskId, signal: { sdp: pc.localDescription } });
        }
      } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    });

    function deleteRemoteFile() {
      const filePath = prompt("Enter full absolute remote path to DELETE (e.g., C:\\temp\\file.txt):");
      if (filePath) {
        const hostId = document.getElementById('target-id').value.trim();
        socket.emit('file_operation', { hostViewdeskId: hostId, op: { action: 'delete', filePath } });
      }
    }

    socket.on('file_op_result', (res) => {
      if (res.success) alert("Operation Successful: " + (res.message || "Done"));
      else alert("Operation Error: " + res.error);
    });

    function endSession() {
      if (pc) pc.close();
      if (localStream) localStream.getTracks().forEach(t => t.stop());
      location.reload();
    }
  </script>
</body>
</html>
  `);
});

// ==========================================
// 6. SIGNALING SERVER & AUTH ROUTING
// ==========================================
io.on("connection", (socket: Socket) => {
  socket.on("register_device", ({ viewdeskId, password }: { viewdeskId: string; password: string }) => {
    activeClientsByViewdeskId.set(viewdeskId, socket.id);
    viewdeskIdsBySocketId.set(socket.id, viewdeskId);
    passwordsByViewdeskId.set(viewdeskId, password);
    console.log(`[ViewDesk Registered] ID: ${viewdeskId} | Password: ${password}`);
  });

  socket.on("request_session_auth", ({ targetViewdeskId, password }: { targetViewdeskId: string; password: string }) => {
    const hostSocketId = activeClientsByViewdeskId.get(targetViewdeskId);
    const correctPassword = passwordsByViewdeskId.get(targetViewdeskId);
    const requesterViewdeskId = viewdeskIdsBySocketId.get(socket.id);

    if (!hostSocketId || !requesterViewdeskId) {
      return socket.emit("auth_failed", { message: "Target ViewDesk ID is offline or invalid." });
    }

    if (correctPassword && password === correctPassword) {
      activeSessions.set(socket.id, { hostViewdeskId: targetViewdeskId, guestViewdeskId: requesterViewdeskId });
      socket.emit("auth_success", { hostViewdeskId: targetViewdeskId });
      io.to(hostSocketId).emit("incoming_authenticated_session", { requesterViewdeskId });
    } else {
      socket.emit("auth_failed", { message: "Incorrect session password." });
    }
  });

  socket.on("webrtc_signal", ({ targetViewdeskId, signal }: { targetViewdeskId: string; signal: any }) => {
    const targetSocketId = activeClientsByViewdeskId.get(targetViewdeskId);
    const senderViewdeskId = viewdeskIdsBySocketId.get(socket.id);
    if (targetSocketId && senderViewdeskId) {
      io.to(targetSocketId).emit("webrtc_signal", { senderViewdeskId, signal });
    }
  });

  socket.on("input_event", async ({ hostViewdeskId, event }: { hostViewdeskId: string; event: InputEvent }) => {
    const session = activeSessions.get(socket.id);
    if (session && session.hostViewdeskId === hostViewdeskId) {
      await DeviceController.executeInput(event);
    }
  });

  socket.on("file_operation", ({ hostViewdeskId, op }: { hostViewdeskId: string; op: FileOperation }) => {
    const hostSocketId = activeClientsByViewdeskId.get(hostViewdeskId);
    if (hostSocketId) {
      const result = DeviceController.handleFileOperation(op);
      socket.emit("file_op_result", result);
    }
  });

  socket.on("disconnect", () => {
    const viewdeskId = viewdeskIdsBySocketId.get(socket.id);
    if (viewdeskId) {
      activeClientsByViewdeskId.delete(viewdeskId);
      viewdeskIdsBySocketId.delete(socket.id);
      passwordsByViewdeskId.delete(viewdeskId);
      activeSessions.delete(socket.id);
      console.log(`[ViewDesk Disconnected] ID: ${viewdeskId}`);
    }
  });
});

// ==========================================
// 7. START SERVER ENGINE
// ==========================================
function startServer(port: number) {
  server.listen(port)
    .on("listening", () => {
      console.log(`
==================================================
  ViewDesk Engine (${DEVELOPER_NAME})
  PC Hardware ID: ${PC_VIEWDESK_ID}
  Session Password: ${PC_SESSION_PASSWORD}
  Listening on Port: ${port}
==================================================
      `);
    })
    .on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        startServer(port + 1);
      } else {
        console.error("[Server Error]", err);
      }
    });
}

startServer(Number(PORT));
