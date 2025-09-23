import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { verifyTokenMiddleware } from "./service/middleware/verifyTokenMiddleware.js";

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Estado de salas
let times = new Map();
const examStatuses = {
  WAITING: "pendiente",
  IN_PROGRESS: "en_progreso",
  PAUSED: "pausado",
  COMPLETED: "completado"
};

// 🔹 Helper para formato HH:MM:SS
function formatTimeHMS(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function normalizeRoomId(roomId) {
  return roomId === undefined || roomId === null ? roomId : String(roomId);
}

// 🔹 Emitir estado
function emitStatus(io, roomId, status) {
  const key = normalizeRoomId(roomId);
  const roomTimeData = times.get(key);
  if (!roomTimeData) return;

  io.to(key).emit("msg", {
    examStatus: status,
    timeLeft: roomTimeData.time,
    timeFormatted: formatTimeHMS(roomTimeData.time),
    serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
  });
}

// 🔹 Pausar examen
function pauseGroupExam(io, roomId) {
  const key = normalizeRoomId(roomId);
  const roomTimeData = times.get(key);
  if (!roomTimeData) return;

  if (roomTimeData.interval) {
    clearInterval(roomTimeData.interval);
    roomTimeData.interval = null;
    times.set(key, roomTimeData);
    emitStatus(io, key, examStatuses.PAUSED);
    console.log(`⏸ Examen pausado - sala ${key}`);
  }
}

// 🔹 Continuar examen
function continueGroupExam(io, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;
  if (roomTimeData.interval || roomTimeData.time <= 0) return;

  console.log(`▶️ Examen reanudado - sala ${roomId}`);
  startGroupExam(io, roomId);
}

// 🔹 Detener examen
function stopGroupExam(io, roomId) {
  const key = normalizeRoomId(roomId);
  const roomTimeData = times.get(key);

  if (!roomTimeData) {
    console.log(`stopGroupExam -> No roomTimeData para sala ${key}`);
    return;
  }

  if (roomTimeData.interval) {
    clearInterval(roomTimeData.interval);
    roomTimeData.interval = null;
  }

  roomTimeData.time = 0;
  times.set(key, roomTimeData);

  io.to(key).emit("msg", {
    examStatus: examStatuses.COMPLETED,
    reason: "stopped", // 👈 diferencia: detenido por docente
    timeLeft: 0,
    timeFormatted: "00:00:00",
    examCompleted: true,
    serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
  });

  console.log(`⏹ Examen detenido - sala ${key}`);
}

// 🔹 Iniciar examen (con contador)
function startGroupExam(io, roomId) {
  const key = normalizeRoomId(roomId);
  const roomTimeData = times.get(key);
  if (!roomTimeData) return;

  if (roomTimeData.interval) {
    console.warn(`⚠️ Ya existe un intervalo en sala ${key}`);
    return;
  }

  console.log(`🚀 Iniciando contador en sala ${key} con ${formatTimeHMS(roomTimeData.time)}`);

  emitStatus(io, key, examStatuses.IN_PROGRESS);

  roomTimeData.interval = setInterval(() => {
    roomTimeData.time--;
    
    if (roomTimeData.time <= 0) {
      clearInterval(roomTimeData.interval);
      roomTimeData.interval = null;
      roomTimeData.time = 0;
      times.set(key, roomTimeData);

      io.to(key).emit("msg", {
        examStatus: examStatuses.COMPLETED,
        reason: "timeup", // 👈 diferencia: finalizó por tiempo
        timeLeft: 0,
        timeFormatted: "00:00:00",
        examCompleted: true,
        serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
      });

      console.log(`✅ Examen completado por tiempo - sala ${key}`);
      return;
    }

    times.set(key, roomTimeData);
    emitStatus(io, key, examStatuses.IN_PROGRESS);
  }, 1000);
}

// ──────────────── ENDPOINTS ────────────────
app.post("/emit/start-evaluation", verifyTokenMiddleware, (req, res) => {
  const { roomId, duration } = req.body;
  const key = normalizeRoomId(roomId);

  times.set(key, { time: duration, interval: null });

  // 🔹 Emitir start con timeFormatted
  io.to(key).emit("start", {
    roomId: key,
    duration,
    timeLeft: duration,
    timeFormatted: formatTimeHMS(duration),
    serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
  });

  startGroupExam(io, key);

  return res.json({ message: "Evento emitido correctamente", roomId: key, duration });
});


app.post("/emit/pause-evaluation", verifyTokenMiddleware, (req, res) => {
  const { roomId } = req.body;
  const key = normalizeRoomId(roomId);

  const roomTimeData = times.get(key);
  if (!roomTimeData) return res.status(404).json({ message: "Sala no encontrada" });

  pauseGroupExam(io, key);
  return res.json({ message: "Examen pausado", roomId: key, timeLeft: roomTimeData.time });
});

// Continuar evaluación
app.post("/emit/continue-evaluation", verifyTokenMiddleware, (req, res) => {
  const { roomId } = req.body;
  const key = normalizeRoomId(roomId);

  const roomTimeData = times.get(key);
  if (!roomTimeData) return res.status(404).json({ message: "Sala no encontrada" });

  if (!roomTimeData.interval && roomTimeData.time > 0) {
    continueGroupExam(io, key);
  }

  return res.json({ message: "Examen reanudado", roomId: key, timeLeft: roomTimeData.time });
});

// Detener evaluación
app.post("/emit/stop-evaluation", verifyTokenMiddleware, (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ message: "roomId requerido" });

  stopGroupExam(io, roomId);

  io.to(roomId).emit("msg", {
    examStatus: examStatuses.COMPLETED,
    reason: "stopped", // detenido por docente
    timeLeft: 0,
    timeFormatted: "00:00:00",
    examCompleted: true,
    serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" }),
  });

  console.log(`🛑 Examen detenido por docente en roomId: ${roomId}`);
  return res.json({ message: "Evento stop-evaluation emitido correctamente" });
});


// ──────────────── SOCKET.IO ────────────────
io.on("connection", (socket) => {
  console.log("✅ Cliente conectado:", socket.id);

  socket.on("join", ({ roomId, role }) => {
    const key = normalizeRoomId(roomId);
    socket.join(key);
    const roomSize = io.sockets.adapter.rooms.get(key)?.size || 0;
    console.log(`📌 Socket ${socket.id} (${role}) se unió a sala ${key}. Total: ${roomSize}`);
    socket.emit("joined", { roomId: key, clientsInRoom: roomSize });
  });

  socket.on("control:pause", ({ roomId }) => pauseGroupExam(io, roomId));
  socket.on("control:continue", ({ roomId }) => continueGroupExam(io, roomId));
  socket.on("control:stop", ({ roomId }) => stopGroupExam(io, roomId));

  socket.on("disconnect", () => {
    console.log("❌ Cliente desconectado:", socket.id);
  });
});

// ──────────────── SERVER ────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
