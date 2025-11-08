// server.js

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// [수정] OpenAI 및 node-fetch 모듈 로드
const { OpenAI } = require('openai');
const fetch = require('node-fetch'); // **여기가 fetch is not a function 에러를 해결하는 핵심**

// [필수] OpenAI API 키를 환경 변수에서 가져옵니다.
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const port = process.env.PORT || 3000;

// 경로 설정
const PUBLIC_PATH = path.join(__dirname, 'public');
const IMAGES_PATH = path.join(__dirname, 'images');
const UPLOADS_PATH = path.join(IMAGES_PATH, 'uploads');

// 폴더 생성
[IMAGES_PATH, UPLOADS_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_PATH),
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// 세션 관리 객체
const activeSessions = {};

// [정적 파일 서빙]
app.use(express.static(PUBLIC_PATH));
app.use('/images', express.static(IMAGES_PATH));

app.use(express.json());

// ===================================================
// PC-모바일 브리지 API (코드 유지)
// ===================================================

app.get('/api/start-upload-session', (req, res) => {
    const sessionId = uuidv4();
    activeSessions[sessionId] = { status: 'waiting' };
    res.json({ sessionId: sessionId, origin: req.protocol + '://' + req.get('host') });
});

app.get('/upload.html', (req, res) => {
    const sessionId = req.query.id;
    if (!sessionId || !activeSessions[sessionId]) {
        return res.status(404).send('유효하지 않거나 만료된 업로드 세션입니다.');
    }
    const uploadFilePath = path.join(__dirname, 'public', 'upload.html');
    fs.readFile(uploadFilePath, 'utf8', (err, data) => {
        if (err) return res.status(500).send('서버 오류: 폼을 로드할 수 없습니다.');
        res.send(data);
    });
});

app.post('/api/mobile-upload/:sessionId', upload.single('mobileImage'), (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeSessions[sessionId];
    // ... (업로드 성공 응답 로직 유지) ...
    if (!session) return res.status(404).send('유효하지 않거나 만료된 세션 ID입니다.');
    if (!req.file) return res.status(400).send('업로드된 파일이 없습니다.');
    activeSessions[sessionId] = { status: 'uploaded', filePath: req.file.path, originalName: req.file.originalname, fileName: path.basename(req.file.path) };
    res.send(`<script>alert('파일 업로드 성공! PC 화면을 확인해주세요.'); setTimeout(function() { window.close(); }, 1000); </script><h1>업로드 성공</h1>`);
});

app.get('/api/check-upload-status/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeSessions[sessionId];
    if (!session) return res.status(404).json({ status: 'error', message: '세션 만료' });
    if (session.status === 'uploaded') {
        delete activeSessions[sessionId];
        return res.json({ status: 'uploaded', fileInfo: session });
    }
    res.json({ status: 'waiting' });
});

// ===================================================
// AI 처리 API (실제 OpenAI 호출 로직 통합)
// ===================================================
app.post('/api/ai-process', upload.single('pcImage'), async (req, res) => {
    const { prompt, style, mode, qrUploadedFileName } = req.body;
    let inputImagePath = null;

    try {
        // 1. 입력 경로 및 유효성 검사 (유지)
        if (mode === 'image' && req.file) {
            inputImagePath = req.file.path;
        } else if (mode === 'qr' && qrUploadedFileName) {
            inputImagePath = path.join(UPLOADS_PATH, qrUploadedFileName);
        } else if (mode === 'text') {
            // 파일 입력 필요 없음
        } else {
            return res.status(400).json({ error: '필수 입력 데이터가 부족하거나 모드가 일치하지 않습니다.' });
        }

        // 2. OpenAI DALL-E 호출
        let finalPrompt = `${prompt} (${style} 스타일로 변환/생성)`;

        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: finalPrompt,
            n: 1,
            size: "1024x1024",
            response_format: 'url',
        });

        const imageUrl = response.data[0].url;

        // 3. [핵심 수정] 이미지 URL에서 Buffer로 다운로드
        const imageResponse = await fetch(imageUrl);

        if (!imageResponse.ok) {
            throw new Error(`Failed to download image from OpenAI URL: ${imageResponse.statusText}`);
        }

        const aiImageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // 4. 파일 저장
        const finalFileName = `ai_result_${uuidv4()}.png`;
        const finalSavePath = path.join(IMAGES_PATH, finalFileName);

        fs.writeFileSync(finalSavePath, aiImageBuffer);

        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생 (server.js):', error);
        res.status(500).json({ error: 'AI 이미지 생성에 실패했습니다.', details: error.message });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));