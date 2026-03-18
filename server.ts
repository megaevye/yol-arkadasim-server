import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors());

app.get("/", (req, res) => {
  res.send("Yol Arkadasim Sunucusu Aktif!");
});

io.on("connection", (socket) => {
  console.log("Bir kullanıcı bağlandı:", socket.id);

  socket.on("update_location", (data) => {
    socket.broadcast.emit("location_updated", data);
  });

  socket.on("disconnect", () => {
    console.log("Kullanıcı ayrıldı:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server ${PORT} portunda calisiyor`);
});
