import { Router } from 'express';
import { authController } from './auth.controller';

export const authRouter = Router();

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Autentica um usuário
 *     description: >
 *       Valida email e senha do usuário.
 *       Em caso de sucesso, retorna um token JWT e os dados do usuário.
 *
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *
 *     responses:
 *       200:
 *         description: Login realizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *
 *       400:
 *         description: Dados da requisição inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: Email e senha são obrigatórios
 *
 *       401:
 *         description: Credenciais inválidas
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: Credenciais inválidas
 */
authRouter.post('/login', authController.login);
