import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { backendService } from "./service/backendService.js";

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json());

// 🔹 Socket.IO con CORS
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Cache de tokens
const tokenCache = new Map();

// Estado de salas
let times = new Map();
const examStatuses = {
  WAITING: "pendiente",
  IN_PROGRESS: "en_progreso",
  PAUSED: "pausado",
  COMPLETED: "completado"
};

// Función de formato HH:MM:SS
function formatTimeHMS(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function normalizeRoomId(roomId) {
  return roomId === undefined || roomId === null ? roomId : String(roomId);
}

// ✅ Helper para emitir estado
function emitStatus(io, roomId, status) {
  const key = normalizeRoomId(roomId);
  const roomTimeData = times.get(key);
  if (!roomTimeData) return;
  //console.log(`🔔 emitStatus -> sala ${key} estado=${status} timeLeft=${roomTimeData.time}`);
  io.to(key).emit("msg", {
    examStatus: status,
    timeLeft: roomTimeData.time,
    timeFormatted: formatTimeHMS(roomTimeData.time),
    serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
  });
}


// ✅ Función de pausar
function pauseGroupExam(io, roomId) {
  const key = normalizeRoomId(roomId);
  console.log("pauseGroupExam called for room:", key);

  const roomTimeData = times.get(key);
  if (!roomTimeData) {
    console.log(`pauseGroupExam -> No roomTimeData para sala ${key}`);
    return;
  }

  console.log("pauseGroupExam -> roomTimeData before:", { time: roomTimeData.time, interval: roomTimeData.interval });

  if (roomTimeData.interval) {
    clearInterval(roomTimeData.interval);
    // log de debugging: cuántos intervalos activos quedan
    console.log("⏱ Intervals activos antes de modificar:", [...times.values()].filter(t => t.interval).length);
    roomTimeData.interval = null;
    times.set(key, roomTimeData);
    emitStatus(io, key, examStatuses.PAUSED);
    console.log(`⏸ Examen pausado - sala ${key}`);
    console.log("pauseGroupExam -> roomTimeData after:", { time: roomTimeData.time, interval: roomTimeData.interval });
  } else {
    console.log(`pauseGroupExam -> No había intervalo activo en sala ${key}`);
  }
}


// ✅ Función de continuar
function continueGroupExam(io, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;
  if (roomTimeData.interval || roomTimeData.time <= 0) return;

  console.log(`▶️ Examen reanudado - sala ${roomId}`);
  startGroupExam(io, roomId); // al iniciar otra vez, ya emite IN_PROGRESS
}

// 🔹 Endpoint: iniciar evaluación
app.post("/emit/start-evaluation", async (req, res) => {
  const { roomId, duration, token } = req.body;
  const key = normalizeRoomId(roomId);
  console.log("➡️ /emit/start-evaluation -> roomId:", roomId, "normalized:", key, "duration:", duration);

  // ... validaciones de token ...
  times.set(key, { time: duration, interval: null });

  io.to(key).emit("start", { roomId: key, duration });
  startGroupExam(io, key);

  return res.json({
    message: "Evento emitido correctamente",
    roomId: key,
    duration,
    clients: io.sockets.adapter.rooms.get(key)?.size || 0
  });
});


// 🔹 Endpoint: pausar evaluación
app.post("/emit/pause-evaluation", async (req, res) => {
  const { roomId, token } = req.body;
  const key = normalizeRoomId(roomId);
  console.log("➡️ /emit/pause-evaluation -> roomId:", roomId, "normalized:", key);

  if (!token) return res.status(401).json({ message: "Token requerido" });

  try {
    const roomTimeData = times.get(key);
    if (!roomTimeData) {
      console.log("➡️ /emit/pause-evaluation -> sala no encontrada en times:", key);
      return res.status(404).json({ message: "Sala no encontrada" });
    }

    pauseGroupExam(io, key);
    return res.json({ message: "Examen pausado", roomId: key, timeLeft: roomTimeData.time });
  } catch (err) {
    console.error("❌ Error al pausar:", err.message);
    return res.status(500).json({ message: "Error interno" });
  }
});

// 🔹 Endpoint: continuar evaluación
app.post("/emit/continue-evaluation", async (req, res) => {
  const { roomId, token } = req.body;
  const key = normalizeRoomId(roomId);
  console.log("➡️ /emit/continue-evaluation -> roomId:", roomId, "normalized:", key);

  if (!token) return res.status(401).json({ message: "Token requerido" });

  try {
    const roomTimeData = times.get(key);
    if (!roomTimeData) return res.status(404).json({ message: "Sala no encontrada" });

    if (!roomTimeData.interval && roomTimeData.time > 0) {
      continueGroupExam(io, key);
    }

    return res.json({ message: "Examen reanudado", roomId: key, timeLeft: roomTimeData.time });
  } catch (err) {
    console.error("❌ Error al continuar:", err.message);
    return res.status(500).json({ message: "Error interno" });
  }
});

// 🔹 Socket conexiones
io.on("connection", (socket) => {
  console.log("✅ Cliente conectado:", socket.id);

  socket.on("join", ({ roomId, role }) => {
  const key = normalizeRoomId(roomId);
  socket.join(key);
  const roomSize = io.sockets.adapter.rooms.get(key)?.size || 0;
  console.log(`📌 Socket ${socket.id} (${role}) se unió a sala ${key}. Total: ${roomSize}`);
  socket.emit("joined", { roomId: key, clientsInRoom: roomSize });
});


  // Control directo por socket (ej: docente manda evento)
  socket.on("control:pause", ({ roomId }) => {
    pauseGroupExam(io, roomId);
  });

  socket.on("control:continue", ({ roomId }) => {
    continueGroupExam(io, roomId);
  });

  socket.on("disconnect", () => {
    console.log("❌ Cliente desconectado:", socket.id);
  });
});

// 🔹 Lógica principal del examen
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
    // decrementa sobre el objeto guardado
    roomTimeData.time--;

    if (roomTimeData.time <= 0) {
      clearInterval(roomTimeData.interval);
      roomTimeData.interval = null;
      roomTimeData.time = 0;
      times.set(key, roomTimeData);

      io.to(key).emit("msg", {
        examStatus: examStatuses.COMPLETED,
        timeLeft: 0,
        timeFormatted: "00:00:00",
        examCompleted: true,
        serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
      });

      console.log(`✅ Examen completado - sala ${key}`);
      return;
    }

    times.set(key, roomTimeData);
    emitStatus(io, key, examStatuses.IN_PROGRESS);
  }, 1000);

  // log extra
  console.log("⏱ Interval creado para sala", key);
  console.log("⏱ Intervals activos ahora:", [...times.values()].filter(t => t.interval).length);
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
