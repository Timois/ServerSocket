import { backendService } from "../backendService.js";
export const verifyTokenMiddleware = async (req, res, next) => {
    const token = req.body.token || req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ message: "Token requerido" });
    }

    try {
        const teacher = await backendService.verifyTeacherToken(token);

        if (!teacher || !teacher.valid) {
            return res.status(401).json({ message: "No autorizado: solo docentes pueden ejecutar esta acción" });
        }

        // Guardamos datos del docente en la request (opcional)
        req.teacher = teacher.user;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Token inválido", error: err.message });
    }
};

export const verifyStudentTokenMiddleware = async (req, res, next) => {
    const token = req.body.token || req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ message: "Token requerido" });
    }

    try {
        const student = await backendService.verifyStudentToken(token);

        if (!student || !student.valid) {
            return res.status(401).json({ message: "No autorizado: solo estudiantes pueden unirse a una sala" });
        }

        // Guardamos datos del estudiante en la request (opcional)
        req.student = student.user;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Token inválido", error: err.message });
    }
};
