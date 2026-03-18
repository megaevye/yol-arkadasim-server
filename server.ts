import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";

interface User {
  id: string;
  type: 'driver' | 'passenger';
  lat: number;
  lng: number;
  destLat?: number;
  destLng?: number;
  destName?: string;
  telegram: string;
  createdAt: number;
  lastUpdate: number;
  disconnectedAt?: number;
  pickupAddress?: string;
  pickupNeighborhood?: string;
  destAddress?: string;
  destNeighborhood?: string;
  price?: string;
  preferredRoutes?: string;
  tabela?: string;
  inCallWith?: string | null;
}

const STATS_FILE = path.join(process.cwd(), "stats.json");

async function startServer() {
const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { 
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
  });

  const PORT = process.env.PORT || 3000;
  let users: Map<string, User> = new Map();
  let messages: any[] = [];
  
  // Persistent stats
  let statsData = {
    totalVisitors: 0,
    totalOffers: 0,
    totalVisits: 0,
    visitorHandles: [] as string[]
  };

  if (fs.existsSync(STATS_FILE)) {
    try {
      statsData = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    } catch (e) {
      console.error("Stats file read error:", e);
    }
  }

  const saveStats = () => {
    try {
      statsData.visitorHandles = Array.from(visitorHandlesSet);
      fs.writeFileSync(STATS_FILE, JSON.stringify(statsData), 'utf8');
    } catch (e) {
      console.error("Stats file save error:", e);
    }
  };

  let visitorHandlesSet = new Set(statsData.visitorHandles || []);

  // Cleanup old messages every hour (keep for 24 hours)
  setInterval(() => {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    messages = messages.filter(m => m.timestamp > twentyFourHoursAgo);
  }, 3600000);

  // Her saniye tüm kullanıcılara güncel listeyi bas (Garanti yöntem)
  setInterval(() => {
    const now = Date.now();
    for (const [socketId, socket] of io.sockets.sockets) {
      const currentUser = users.get(socketId);
      if (!currentUser) continue;

      const visibleUsers = Array.from(users.values()).filter(u => {
        // Basic connectivity check: 30 second grace period for background apps
        if (u.disconnectedAt && now - u.disconnectedAt > 30000) return false;
        return true;
      });
      
      socket.emit('users_update', visibleUsers);
    }
  }, 2000);

  // İstatistikleri her 5 saniyede bir tüm bağlı kullanıcılara gönder
  setInterval(() => {
    io.emit('stats_update', {
      onlineUsers: io.engine.clientsCount,
      totalVisitors: visitorHandlesSet.size,
      totalOffers: statsData.totalOffers,
      totalVisits: statsData.totalVisits
    });
  }, 5000);

  // Temizlik (10 dakika hareketsizlik veya 120 dakika toplam süre)
  setInterval(() => {
    const now = Date.now();
    for (const [id, user] of users.entries()) {
      if (now - user.createdAt > 120 * 60 * 1000 || (user.disconnectedAt && now - user.disconnectedAt > 300000)) {
        users.delete(id);
      }
    }
  }, 10000);

  io.on("connection", (socket) => {
    console.log("Yeni bağlantı:", socket.id);
    statsData.totalVisits++;
    saveStats();

    socket.on("register", (userData: any) => {
      // Aynı telegram adresine sahip eski kayıtları temizle
      for (const [id, u] of users.entries()) {
        if (u.telegram === userData.telegram && id !== socket.id) {
          // Transfer call state if applicable
          const oldUser = users.get(id);
          if (oldUser?.inCallWith) {
            userData.inCallWith = oldUser.inCallWith;
          }
          users.delete(id);
        }
      }
      
      if (userData.telegram) {
        if (!visitorHandlesSet.has(userData.telegram)) {
          visitorHandlesSet.add(userData.telegram);
          saveStats();
        }
      }
      
      users.set(socket.id, {
        ...userData,
        id: socket.id,
        createdAt: userData.createdAt || Date.now(),
        lastUpdate: Date.now(),
        disconnectedAt: undefined
      });

      // Send relevant messages from last 24 hours based on telegram handle
      const userTelegram = userData.telegram;
      const userMsgs = messages.filter(m => m.toTelegram === userTelegram || m.fromTelegram === userTelegram);
      socket.emit('initial_messages', userMsgs);
    });

    socket.on("update_location", (data: { lat: number; lng: number }) => {
      const user = users.get(socket.id);
      if (user) {
        user.lat = data.lat;
        user.lng = data.lng;
        user.lastUpdate = Date.now();
        user.disconnectedAt = undefined;
      }
    });

    socket.on("send_message", (data: { id?: string; to: string; text: string; type: string; offerStatus?: string; data?: any; fromName?: string }) => {
      const fromUser = users.get(socket.id);
      const toUser = users.get(data.to);
      if (!fromUser) return;

      const message = {
        id: data.id || Math.random().toString(36).substr(2, 9),
        from: socket.id,
        fromTelegram: fromUser.telegram,
        to: data.to,
        toTelegram: toUser?.telegram,
        text: data.text,
        timestamp: Date.now(),
        type: data.type,
        offerStatus: data.offerStatus,
        data: data.data,
        fromName: data.fromName,
        status: 'sent'
      };

      if (data.type === 'offer') {
        statsData.totalOffers++;
        saveStats();
      }

      messages.push(message);

      // Send to recipient
      io.to(data.to).emit("receive_message", message);
      // Send back to sender for confirmation
      socket.emit("receive_message", message);
    });

    socket.on("update_message_status", (data: { messageId: string; status: 'delivered' | 'read'; from: string }) => {
      const msg = messages.find(m => m.id === data.messageId);
      if (msg) {
        msg.status = data.status;
        // Notify the sender about the status update
        io.to(msg.from).emit("message_status_update", { messageId: data.messageId, status: data.status });
      }
    });

    socket.on("remove_user", () => {
      users.delete(socket.id);
    });

    socket.on("ping", () => {
      socket.emit("pong");
    });

    socket.on("call_user", (data: { to: string; offer: any }) => {
      const fromUser = users.get(socket.id);
      const toUser = users.get(data.to);
      
      if (toUser?.inCallWith) {
        // Recipient is busy
        socket.emit("call_busy", { to: data.to });
        
        // Notify the recipient that someone tried to call
        const message = {
          id: Math.random().toString(36).substr(2, 9),
          from: socket.id,
          fromTelegram: fromUser?.telegram,
          to: data.to,
          toTelegram: toUser.telegram,
          text: `Siz meşgulken @${fromUser?.telegram.replace('t.me/', '') || 'bir kullanıcı'} sizi aradı.`,
          timestamp: Date.now(),
          type: 'text',
          fromName: fromUser?.telegram.replace('t.me/', ''),
          status: 'sent'
        };
        messages.push(message);
        io.to(data.to).emit("receive_message", message);
        return;
      }

      io.to(data.to).emit("call_offer", { from: socket.id, offer: data.offer });
    });

    socket.on("answer_call", (data: { to: string; answer: any }) => {
      const user = users.get(socket.id);
      const otherUser = users.get(data.to);
      if (user) user.inCallWith = data.to;
      if (otherUser) otherUser.inCallWith = socket.id;
      
      io.to(data.to).emit("call_answer", { answer: data.answer });
    });

    socket.on("ice_candidate", (data: { to: string; candidate: any }) => {
      io.to(data.to).emit("ice_candidate", { candidate: data.candidate });
    });

    socket.on("end_call", (data: { to: string }) => {
      const user = users.get(socket.id);
      const otherUser = users.get(data.to);
      if (user) user.inCallWith = null;
      if (otherUser) otherUser.inCallWith = null;
      
      io.to(data.to).emit("call_ended");
    });

    socket.on("disconnect", () => {
      const user = users.get(socket.id);
      if (user) {
        user.disconnectedAt = Date.now();
        // If in call, notify the other party
        if (user.inCallWith) {
          io.to(user.inCallWith).emit("call_ended");
          const otherUser = users.get(user.inCallWith);
          if (otherUser) otherUser.inCallWith = null;
        }
      }
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    //app.use(express.static(path.join(process.cwd(), "dist")));
    //app.get("*", (req, res) => res.sendFile(path.join(process.cwd(), "dist", "index.html")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Sunucu aktif: http://0.0.0.0:${PORT}`);
  });
}

startServer();
