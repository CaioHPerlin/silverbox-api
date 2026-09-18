import { Router } from 'express';

import { filesController } from './files.controller';
import { authMiddleware } from '../../middlewares/auth.middleware';
import { upload } from '../../middlewares/upload.middleware';

export const filesRouter = Router();

/**
 * @openapi
 * /api/files/upload:
 *   post:
 *     tags:
 *       - Files
 *     summary: Faz upload de um arquivo
 *     description: >
 *       Faz upload de um arquivo para a nuvem.
 *       O usuário precisa estar autenticado e possuir cota
 *       de armazenamento suficiente.
 *
 *     security:
 *       - bearerAuth: []
 *
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Arquivo que será enviado ao MinIO.
 *
 *     responses:
 *       201:
 *         description: Arquivo enviado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FileUploadResponse'
 *             example:
 *               fileId: 550e8400-e29b-41d4-a716-446655440001
 *               originalName: documento.pdf
 *               size: 1024000
 *
 *       400:
 *         description: Nenhum arquivo enviado ou dados inválidos
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               noFile:
 *                 summary: Nenhum arquivo enviado
 *                 value:
 *                   error: Nenhum arquivo enviado
 *
 *       401:
 *         description: Usuário não autenticado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               error: Não autorizado
 *
 *       413:
 *         description: Limite de armazenamento excedido ou arquivo muito grande
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               quotaExceeded:
 *                 summary: Cota de armazenamento excedida
 *                 value:
 *                   error: Cota de armazenamento excedida
 *               fileTooLarge:
 *                 summary: Arquivo acima do limite permitido
 *                 value:
 *                   error: Arquivo muito grande
 */
filesRouter.post(
  '/upload',
  authMiddleware,
  upload.single('file'),
  filesController.upload,
);
