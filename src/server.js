import express from 'express';
import http from 'http';
import { Server } from "socket.io";
import axios from 'axios';
// const urlBackend = import.meta.env.VITE_API_ENDPOINT;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // cambia a tu frontend en producción
    methods: ["GET", "POST"],
  },
});

// Middleware de autenticación v2
io.use(async (socket, next) => {
  const token = socket.handshake.query.token; // en v2, viene por query
  if (!token) return next(new Error("Token requerido"));

  try {
    // Intentamos verificar en backend Laravel
    let response = await axios.get('http://127.0.0.1:8000/api/users/verifyTeacherToken', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.data.valid) {
      socket.user = response.data.user;
      socket.role = 'teacher';
      return next();
    }

    response = await axios.get('http://127.0.0.1:8000/api/students/verifyStudentToken', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.data.valid) {
      socket.user = response.data.user;
      socket.role = 'student';
      return next();
    }

    return next(new Error("Token inválido"));
  } catch (err) {
    return next(new Error("Error verificando token con backend"));
  }
});


io.on('connection', (socket) => {
  console.log('✅ Usuario conectado:', socket.user);

  socket.on('join', (payload) =>
    execute(socket, { action: 'join', roomId: payload.roomId })
  );
  socket.on('duration', (payload) =>
    execute(socket, { action: 'duration', roomId: payload.roomId, time: payload.time })
  );
  socket.on('start', (payload) =>
    execute(socket, { action: 'start', roomId: payload.roomId })
  );
  socket.on('pause', (payload) =>
    execute(socket, { action: 'pause', roomId: payload.roomId })
  );
  socket.on('continue', (payload) =>
    execute(socket, { action: 'continue', roomId: payload.roomId })
  );
  socket.on('stop', (payload) =>
    execute(socket, { action: 'stop', roomId: payload.roomId })
  );
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

let times = new Map();

function execute(socket, payload) {
  switch (payload.action) {
    case 'join':
      joinConnection(socket, payload.roomId);
      break;
    case 'duration':
      setDuration(socket, payload.roomId, payload.time);
      break;
    case 'start':
      startGroupExam(socket, payload.roomId);
      break;
    case 'pause':
      pauseGroupExam(socket, payload.roomId);
      break;
    case 'continue':
      continueGroupExam(socket, payload.roomId);
      break;
    case 'stop':
      stopGroupExam(socket, payload.roomId);
      break;
    default:
      socket.emit('msg', { msg: 'Evento Erróneo' });
      break;
  }
}

function joinConnection(socket, roomId) {
  socket.join(roomId);
  socket.to(roomId).emit('msg', { msg: `Usuario unido a la sala: ${roomId}` });
}

function setDuration(socket, roomId, time) {
  times.set(roomId, { time, interval: null });
  console.log(`Tiempo configurado para la sala ${roomId}: ${time} segundos`);
  socket.to(roomId).emit('msg', {
    msg: `Tiempo de examen configurado en ${time} minutos para la sala ${roomId}`,
  });
}

function startGroupExam(socket, roomId) {
  const roomTimeData = times.get(roomId);
  if (!roomTimeData) {
    socket.emit('msg', { msg: `No se encontro la duracion de la sala ${roomId}` });
    return;
  }

  let { time } = roomTimeData;

  socket.to(roomId).emit('msg', {
    isStarted: examStatuses.STARTED,
    timeLeft: time,
    timeFormatted: formatTimeHMS(time),
    serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
  });

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
      isStarted: examStatuses.STARTED,
      timeLeft: time,
      timeFormatted: formatTimeHMS(time),
      serverTime: new Date().toLocaleTimeString('es-ES', { timeZone: 'America/La_Paz' }),
    });

    console.log(`Tiempo: ${formatTimeHMS(time)} para la sala ${roomId}`);
  }, 1000);
}

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