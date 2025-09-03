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
  STARTED: 'started',
  COMPLETED: 'completed'
};

// Función de formato HH:MM:SS
function formatTimeHMS(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
// 🔹 Endpoint: iniciar evaluación
app.post("/emit/start-evaluation", async (req, res) => {
  const { roomId, duration, token } = req.body;
  
  console.log("➡️ duration (segundos):", duration);
  if (!token) return res.status(401).json({ message: "Token requerido" });
  if (!duration || duration <= 0) return res.status(400).json({ message: "Duración inválida" });

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

// 🔹 Socket conexiones
io.on("connection", (socket) => {
  console.log("✅ Cliente conectado:", socket.id);

  socket.on("join", ({ roomId, role }) => {
    socket.join(roomId);
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`📌 Socket ${socket.id} (${role}) se unió a sala ${roomId}. Total: ${roomSize}`);
    socket.emit("joined", { roomId, clientsInRoom: roomSize });
  });

  socket.on("disconnect", () => {
    console.log("❌ Cliente desconectado:", socket.id);
  });
});

function startGroupExam(io, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) return;

  let time = roomTimeData.time;

  console.log(`🚀 Iniciando contador en sala ${roomId} con ${formatTimeHMS(time)}`);

  // Emitir primer estado
  io.to(roomId).emit("msg", {
    isStarted: examStatuses.STARTED,
    timeLeft: time,
    timeFormatted: formatTimeHMS(time),
    serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
  });

  // Iniciar intervalo
  roomTimeData.interval = setInterval(() => {
    --time

    // 🔹 Imprimir tiempo restante en formato HH:MM:SS
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
        serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
      });

      console.log(`✅ Examen completado - sala ${roomId}`);
      return;
    }

    // Actualizar y enviar tiempo
    roomTimeData.time = time;
    times.set(roomId, roomTimeData);

    io.to(roomId).emit("msg", {
      isStarted: examStatuses.STARTED,
      timeLeft: time,
      timeFormatted: formatTimeHMS(time),
      serverTime: new Date().toLocaleTimeString("es-ES", { timeZone: "America/La_Paz" })
    });
  }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));


function pauseGroupExam(socket, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) {
    socket.emit('msg', { msg: `No se encontró la sala con id ${roomId}` });
    return;
  }

  if (roomTimeData.interval) {
    clearInterval(roomTimeData.interval);
    roomTimeData.interval = null;
    times.set(roomId, roomTimeData);

    socket.to(roomId).emit('msg', {
      isStarted: examStatuses.PAUSED,
      timeLeft: roomTimeData.time,
      timeFormatted: formatTimeHMS(roomTimeData.time),
      serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
    });

    console.log(`Examen pausado para la sala ${roomId}, tiempo restante: ${formatTimeHMS(roomTimeData.time)}`);
  } else {
    socket.emit('msg', { msg: `No hay un examen activo para pausar en la sala ${roomId}` });
  }
}

function continueGroupExam(socket, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) {
    socket.emit('msg', { msg: `No se encontró la sala con id ${roomId}` });
    return;
  }

  if (roomTimeData.interval) {
    socket.emit('msg', { msg: `El examen ya está en curso en la sala ${roomId}` });
    return;
  }

  let { time } = roomTimeData;
  roomTimeData.interval = setInterval(() => {
    --time;

    if (time <= 0) {
      clearInterval(roomTimeData.interval);
      roomTimeData.interval = null;
      times.set(roomId, roomTimeData);

      socket.to(roomId).emit('msg', {
        isStarted: examStatuses.COMPLETED,
        timeLeft: 0,
        timeFormatted: '00:00:00',
        serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
        examCompleted: true,
      });

      console.log(`Examen completado - tiempo agotado para la sala ${roomId}`);
      return;
    }

    roomTimeData.time = time;
    times.set(roomId, roomTimeData);

    socket.to(roomId).emit('msg', {
      isStarted: examStatuses.CONTINUED,
      timeLeft: time,
      timeFormatted: formatTimeHMS(time),
      serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
    });

    console.log(`Tiempo: ${formatTimeHMS(time)} para la sala ${roomId}`);
  }, 1000);

  socket.to(roomId).emit('msg', {
    isStarted: examStatuses.CONTINUED,
    timeLeft: time,
    timeFormatted: formatTimeHMS(time),
    serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
  });

  console.log(`Examen reanudado para la sala ${roomId}`);
}

function stopGroupExam(socket, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) {
    socket.emit('msg', { msg: `No se encontró la sala con id ${roomId}` });
    return;
  }

  if (roomTimeData.interval) {
    clearInterval(roomTimeData.interval);
    roomTimeData.interval = null;
  }

  times.delete(roomId);

  socket.to(roomId).emit('msg', {
    isStarted: examStatuses.STOPPED,
    timeLeft: 0,
    timeFormatted: '00:00:00',
    serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
    examStopped: true,
  });

  console.log(`Examen detenido para la sala ${roomId}`);
}