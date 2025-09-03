// services/backendService.js
import axios from "axios";

const BASE_URL = "http://127.0.0.1:8000/api"; // 👈 Centralizamos aquí la URL de Laravel

// Opcional: agregar token de Laravel si tu backend requiere autenticación
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    "Content-Type": "application/json",
  },
});

export const backendService = {
  // Obtener grupos por evaluación
  async getEvaluationForGroup(group_id, token = null) {
    try {
      const res = await api.put(`/groups/startGroup/${group_id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      console.log("📡 Respuesta de Laravel:", res.data);
      return res.data;
    } catch (err) {
      console.error("❌ Error obteniendo grupos:", err.message);
      throw err;
    }
  },

  // Otro ejemplo: verificar token de usuario
  async verifyTeacherToken(token) {
    try {
      const res = await api.get("/users/verifyTeacherToken", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    } catch (err) {
      console.error("❌ Error verificando token:", err.message);
      throw err;
    }
  },

  async verifyStudentToken(token) {
    try {
      const res = await api.get("/students/verifyStudentToken", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.data;
    } catch (err) {
      console.error("❌ Error verificando token:", err.message);
      throw err;
    }
  },
};