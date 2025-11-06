const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Render 환경에서는 PORT 환경 변수를 사용해야 합니다.
const PORT = process.env.PORT || 3000;

// ----- 폴더 및 설정 (수정: transformed 폴더를 public 안으로 이동하여 접근성 확보) -----
// Render 환경에서는 최상위 폴더가 루트입니다.
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const TRANSFORMED_DIR = path.join(__dirname, 'public', 'transformed');

// 폴더가 없으면 생성 (Render 환경에서도 빌드 시에 생성됩니다)
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TRANSFORMED_DIR)) fs.mkdirSync(TRANSFORMED_DIR, { recursive: true });

// ----- Multer 설정: 이미지 업로드 처리 -----
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // 실제 저장 경로는 public/uploads 입니다.
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, uuidv4() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ----- 정적 파일 서비스 (public 폴더를 루트로 설정) -----
app.use(express.static(path.join(__dirname, 'public')));
// 이제 /uploads/파일명 이나 /transformed/파일명 으로 바로 접근 가능합니다.

// ----- 세션 관리 -----
const sessions = {};

// ----- Socket.IO 실시간 통신 -----
io.on('connection', (socket) => {
    socket.on('createSession', () => {
        const sessionId = uuidv4();
        sessions[sessionId] = { pcSocketId: socket.id, uploadedImage: null, transformedImage: null };
        const uploadUrl = `/upload.html?sessionId=${sessionId}`;
        socket.emit('sessionCreated', { sessionId: sessionId, uploadUrl: uploadUrl });
    });

    socket.on('disconnect', () => {
        for (const sessionId in sessions) {
            if (sessions[sessionId].pcSocketId === socket.id) {
                delete sessions[sessionId];
                break;
            }
        }
    });
});

// ----- 이미지 업로드 API (POST /upload-image) -----
app.post('/upload-image', upload.single('image'), async (req, res) => {
    const sessionId = req.body.sessionId;
    // URL 경로는 public 폴더 기준으로 잡힙니다.
    const imageUrl = `/uploads/${req.file.filename}`;

    if (!sessionId || !sessions[sessionId]) {
        // 업로드 후 에러 발생 시 파일 삭제 (선택적)
        fs.unlinkSync(req.file.path);
        return res.status(400).send({ message: '유효하지 않은 세션 ID입니다.' });
    }

    sessions[sessionId].uploadedImage = imageUrl;

    // 1. PC 화면에 원본 이미지 도착 알림
    io.to(sessions[sessionId].pcSocketId).emit('imageUploaded', { imageUrl: imageUrl });

    // 2. AI 변환 실행 (더미 로직)
    // AI 변환 로직은 시간이 걸릴 수 있으므로 async/await을 사용합니다.
    const transformedImageUrl = await performAITransformation(req.file.path);
    sessions[sessionId].transformedImage = transformedImageUrl;

    // 3. PC 화면에 변환 완료 알림
    io.to(sessions[sessionId].pcSocketId).emit('imageTransformed', { transformedImageUrl: transformedImageUrl });

    res.send({ message: '업로드 및 처리 완료' });
});

// ----- AI 변환 더미 함수 (실제 AI 로직으로 대체 필수) -----
async function performAITransformation(originalFilePath) {
    // Render 서버는 이미지를 생성한 후, TRANSFORMED_DIR에 저장해야 합니다.
    const originalFilename = path.basename(originalFilePath);
    const transformedFilename = `transformed_${originalFilename}`;
    const transformedFilePath = path.join(TRANSFORMED_DIR, transformedFilename);

    // 원본 파일을 transformed 폴더에 복사하는 것으로 AI 변환을 대체
    try {
        fs.copyFileSync(originalFilePath, transformedFilePath);
    } catch (error) {
        console.error("AI 변환 더미 중 에러:", error);
    }

    // 최종 다운로드 URL 경로를 반환합니다.
    return `/transformed/${transformedFilename}`;
}

server.listen(PORT, () => {
    // Render 환경에서는 http://localhost:3000 메시지가 아니라,
    // "Server running on port [PORT 번호]" 와 같은 메시지를 출력하는 것이 일반적입니다.
    console.log(`Server is running on port ${PORT}`);
});