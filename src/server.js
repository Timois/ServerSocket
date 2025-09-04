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
  STARTED: "started",
  COMPLETED: "completed",
  PAUSED: "paused",
  CONTINUED: "continued",
  STOPPED: "stopped"
};

// Función de formato HH:MM:SS
function formatTimeHMS(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ✅ Helper para emitir estado
function emitStatus(io, roomId, status) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;
  io.to(roomId).emit("msg", {
    isStarted: status,
    timeLeft: roomTimeData.time,
    timeFormatted: formatTimeHMS(roomTimeData.time),
    serverTime: new Date().toLocaleTimeString("es-ES", {
      timeZone: "America/La_Paz"
    })
  });
}

// ✅ Función para pausar
function pauseGroupExam(io, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;

  if (roomTimeData.interval) {
    clearInterval(roomTimeData.interval);
    roomTimeData.interval = null;
    times.set(roomId, roomTimeData);
    emitStatus(io, roomId, examStatuses.PAUSED);
    console.log(`⏸ Examen pausado - sala ${roomId}`);
  }
}

// ✅ Función para continuar
function continueGroupExam(io, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;
  if (roomTimeData.interval || roomTimeData.time <= 0) return; // ya corriendo o sin tiempo

  emitStatus(io, roomId, examStatuses.CONTINUED);
  console.log(`▶️ Examen reanudado - sala ${roomId}`);
  startGroupExam(io, roomId);
}

// 🔹 Endpoint: iniciar evaluación
app.post("/emit/start-evaluation", async (req, res) => {
  const { roomId, duration, token } = req.body;

  console.log("➡️ duration (segundos):", duration);
  if (!token) return res.status(401).json({ message: "Token requerido" });
  if (!duration || duration <= 0)
    return res.status(400).json({ message: "Duración inválida" });

  try {
    // Validar token con cache o Laravel
    let verification = tokenCache.get(token);
    if (!verification || verification.expires <= Date.now()) {
      let response = await backendService.verifyTeacherToken(token);
      if (!response.valid) {
        response = await backendService.verifyStudentToken(token);
      }
      verification = response;
      tokenCache.set(token, { ...verification, expires: Date.now() + 60000 });
    }

    if (!verification.valid) {
      return res.status(401).json({ message: "Token inválido" });
    }

    // Guardar duración en memoria
    times.set(roomId, { time: duration, interval: null });

    // Emitir inicio a la sala
    io.to(roomId).emit("start", { roomId, duration });
    startGroupExam(io, roomId);

    return res.json({
      message: "Evento emitido correctamente",
      roomId,
      duration,
      clients: io.sockets.adapter.rooms.get(roomId)?.size || 0
    });
  } catch (err) {
    console.error("❌ Error verificando token:", err.message);
    return res.status(500).json({ message: "Error interno" });
  }
});

// 🔹 Endpoint: pausar evaluación
app.post("/emit/pause-evaluation", async (req, res) => {
  const { roomId, token } = req.body;
  if (!token) return res.status(401).json({ message: "Token requerido" });

  try {
    const roomTimeData = times.get(roomId);
    if (!roomTimeData) return res.status(404).json({ message: "Sala no encontrada" });

    pauseGroupExam(io, roomId);
    return res.json({ message: "Examen pausado", roomId, timeLeft: roomTimeData.time });
  } catch (err) {
    console.error("❌ Error al pausar:", err.message);
    return res.status(500).json({ message: "Error interno" });
  }
});

// 🔹 Endpoint: continuar evaluación
app.post("/emit/continue-evaluation", async (req, res) => {
  const { roomId, token } = req.body;
  if (!token) return res.status(401).json({ message: "Token requerido" });

  try {
    const roomTimeData = times.get(roomId);
    if (!roomTimeData) return res.status(404).json({ message: "Sala no encontrada" });

    if (!roomTimeData.interval && roomTimeData.time > 0) {
      continueGroupExam(io, roomId);
    }

    return res.json({ message: "Examen reanudado", roomId, timeLeft: roomTimeData.time });
  } catch (err) {
    console.error("❌ Error al continuar:", err.message);
    return res.status(500).json({ message: "Error interno" });
  }
});

// 🔹 Socket conexiones
io.on("connection", (socket) => {
  console.log("✅ Cliente conectado:", socket.id);

  socket.on("join", ({ roomId, role }) => {
    socket.join(roomId);
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`📌 Socket ${socket.id} (${role}) se unió a sala ${roomId}. Total: ${roomSize}`);
    socket.emit("joined", { roomId, clientsInRoom: roomSize });
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

// 🔹 Lógica principal de examen
function startGroupExam(io, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;

  if (roomTimeData.interval) {
    console.warn(`⚠️ Ya existe un intervalo en sala ${roomId}`);
    return;
  }

  let time = roomTimeData.time;
  console.log(`🚀 Iniciando contador en sala ${roomId} con ${formatTimeHMS(time)}`);

  emitStatus(io, roomId, examStatuses.STARTED);

  roomTimeData.interval = setInterval(() => {
    --time;

    console.log(`⏱ Sala ${roomId} - tiempo restante: ${formatTimeHMS(time)}`);

    if (time <= 0) {
      clearInterval(roomTimeData.interval);
      roomTimeData.interval = null;
      times.set(roomId, { ...roomTimeData, time: 0 });

      io.to(roomId).emit("msg", {
        isStarted: examStatuses.COMPLETED,
        timeLeft: 0,
        timeFormatted: "00:00:00",
        examCompleted: true,
        serverTime: new Date().toLocaleTimeString("es-ES", {
          timeZone: "America/La_Paz"
        })
      });

      console.log(`✅ Examen completado - sala ${roomId}`);
      return;
    }

    roomTimeData.time = time;
    times.set(roomId, roomTimeData);
    emitStatus(io, roomId, examStatuses.STARTED);
  }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
