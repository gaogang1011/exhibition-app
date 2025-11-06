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

const PORT = process.env.PORT || 3000;

// ----- 폴더 및 설정 -----
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TRANSFORMED_DIR = path.join(__dirname, 'transformed');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(TRANSFORMED_DIR)) fs.mkdirSync(TRANSFORMED_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, uuidv4() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/transformed', express.static(TRANSFORMED_DIR));

const sessions = {}; // 세션 ID와 소켓 ID 연결 관리

// ----- Socket.IO 실시간 통신 -----
io.on('connection', (socket) => {
    // PC 화면에서 세션 생성 요청 시
    socket.on('createSession', () => {
        const sessionId = uuidv4();
        sessions[sessionId] = { pcSocketId: socket.id, uploadedImage: null, transformedImage: null };
        const uploadUrl = `/upload.html?sessionId=${sessionId}`;
        socket.emit('sessionCreated', { sessionId: sessionId, uploadUrl: uploadUrl });
    });

    // 클라이언트 연결 해제 시 세션 정리 (생략 가능)
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
    const imageUrl = `/uploads/${req.file.filename}`;

    if (!sessionId || !sessions[sessionId]) {
        return res.status(400).send({ message: '유효하지 않은 세션 ID입니다.' });
    }

    sessions[sessionId].uploadedImage = imageUrl;

    // 1. PC 화면에 원본 이미지 도착 알림
    io.to(sessions[sessionId].pcSocketId).emit('imageUploaded', { imageUrl: imageUrl });

    // 2. AI 변환 실행 (더미 로직)
    const transformedImageUrl = await performAITransformation(req.file.path);
    sessions[sessionId].transformedImage = transformedImageUrl;

    // 3. PC 화면에 변환 완료 알림
    io.to(sessions[sessionId].pcSocketId).emit('imageTransformed', { transformedImageUrl: transformedImageUrl });

    res.send({ message: '업로드 및 처리 완료' });
});

// ----- AI 변환 더미 함수 (실제 AI 로직으로 대체 필수) -----
async function performAITransformation(originalFilePath) {
    // 실제 AI API를 호출하고 결과를 TRANSFORMED_DIR에 저장하는 로직이 필요합니다.
    const originalFilename = path.basename(originalFilePath);
    const transformedFilename = `transformed_${originalFilename}`;
    const transformedFilePath = path.join(TRANSFORMED_DIR, transformedFilename);

    // 여기서는 원본 파일을 transformed 폴더에 복사하는 것으로 AI 변환을 대체합니다.
    try {
        fs.copyFileSync(originalFilePath, transformedFilePath);
    } catch (error) {
        console.error("AI 변환 더미 중 에러:", error);
    }

    return `/transformed/${transformedFilename}`; // 최종 다운로드 경로 반환
}

server.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});