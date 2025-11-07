// server.js (Node.js/Express)

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai'); // ⭐️ 새로 추가
const fetch = require('node-fetch'); // ⭐️ 새로 추가 (이미지 다운로드용)

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const port = process.env.PORT || 3000;

// 경로 설정
const PUBLIC_PATH = path.join(__dirname, 'public');
const IMAGES_PATH = path.join(__dirname, 'images');
const UPLOADS_PATH = path.join(IMAGES_PATH, 'uploads');

// 폴더 생성 (없으면 생성)
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
const activeSessions = {}; // { sessionId: { status: 'waiting'/'uploaded', filePath: '경로', originalName: '이름' } }

app.use(express.static(PUBLIC_PATH));
app.use(express.json());

// ===================================================
// PC-모바일 브리지 API
// ===================================================

// A. PC가 세션 시작 요청
app.get('/api/start-upload-session', (req, res) => {
    const sessionId = uuidv4();
    activeSessions[sessionId] = { status: 'waiting' };
    res.json({ sessionId: sessionId, origin: req.protocol + '://' + req.get('host') });
});

// B. [수정] 모바일이 QR 스캔 후 접속하는 경로 (upload.html 파일을 서빙)
app.get('/upload.html', (req, res) => {
    const sessionId = req.query.id;

    if (!sessionId || !activeSessions[sessionId]) {
        return res.status(404).send('유효하지 않거나 만료된 업로드 세션입니다.');
    }

    // upload.html 파일을 읽어서 클라이언트에 전송
    const uploadFilePath = path.join(__dirname, 'public', 'upload.html');
    fs.readFile(uploadFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading upload.html:', err);
            return res.status(500).send('서버 오류: 폼을 로드할 수 없습니다.');
        }
        res.send(data);
    });
});


// C. 모바일 장치가 파일을 업로드하는 POST API
app.post('/api/mobile-upload/:sessionId', upload.single('mobileImage'), (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeSessions[sessionId];

    if (!session) return res.status(404).send('유효하지 않거나 만료된 세션 ID입니다.');
    if (!req.file) return res.status(400).send('업로드된 파일이 없습니다.');

    // 세션 정보 업데이트
    activeSessions[sessionId] = {
        status: 'uploaded',
        filePath: req.file.path,
        originalName: req.file.originalname,
        fileName: path.basename(req.file.path)
    };

    // 모바일 응답
    res.send(`
        <script>
            alert('파일 업로드 성공! PC 화면을 확인해주세요.');
            setTimeout(function() { window.close(); }, 1000); 
        </script>
        <h1>업로드 성공</h1>
    `);
});

// D. PC가 업로드 상태 확인 (Polling)
app.get('/api/check-upload-status/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeSessions[sessionId];

    if (!session) return res.status(404).json({ status: 'error', message: '세션 만료' });

    if (session.status === 'uploaded') {
        // 업로드 성공 시 파일 정보와 함께 상태 반환
        delete activeSessions[sessionId]; // 세션 정리
        return res.json({ status: 'uploaded', fileInfo: session });
    }

    res.json({ status: 'waiting' });
});


// ===================================================
// AI 처리 API (모든 모드 통합)
// ===================================================
app.post('/api/ai-process', upload.single('pcImage'), async (req, res) => {
    // ... (req.body 및 inputImagePath 설정 로직 유지) ...
    const { prompt, style, mode, qrUploadedFileName } = req.body;
    let inputImagePath = null;

    try {
        // --- 1. 입력 경로 및 유효성 검사 (유지) ---
        if (mode === 'image' && req.file) {
            inputImagePath = req.file.path;
        } else if (mode === 'qr' && qrUploadedFileName) {
            inputImagePath = path.join(UPLOADS_PATH, qrUploadedFileName);
        } else if (mode === 'text') {
            // 파일 입력 필요 없음
        } else {
            return res.status(400).json({ error: '필수 입력 데이터가 부족하거나 모드가 일치하지 않습니다.' });
        }

        // --- 2. OpenAI DALL-E 호출 및 URL 획득 ---
        let finalPrompt = `${prompt} (${style})`;

        // Image to Image 기능 구현 시, DALL-E 3는 직접적인 Image-to-Image 변환을 지원하지 않으므로,
        // 프롬프트에 이미지 내용을 포함하도록 유도합니다 (Text-Guided Image Generation).

        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: finalPrompt,
            n: 1,
            size: "1024x1024",
            response_format: 'url', // URL로 결과 받기
        });

        const imageUrl = response.data[0].url; // AI가 생성한 이미지의 임시 URL

        // --- 3. [오류 수정] 이미지 URL에서 Buffer로 다운로드 및 저장 ---

        const imageResponse = await fetch(imageUrl);

        if (!imageResponse.ok) {
            throw new Error(`Failed to download image from OpenAI URL: ${imageResponse.statusText}`);
        }

        // 다운로드 받은 이미지를 Buffer로 변환합니다. (aiImageBuffer 정의)
        const aiImageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // --- 4. [오류 수정] 파일 저장 경로 설정 및 저장 ---

        // finalFileName, finalSavePath 정의
        const finalFileName = `ai_result_${uuidv4()}.png`; // PNG 확장자로 저장
        const finalSavePath = path.join(IMAGES_PATH, finalFileName);

        // [파일 저장] Buffer를 파일 시스템에 씁니다.
        fs.writeFileSync(finalSavePath, aiImageBuffer);

        // --- 5. [오류 수정] 클라이언트 반환 URL 설정 ---

        // aiImageUrl 정의 (클라이언트가 접근 가능한 경로)
        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생 (server.js):', error);
        res.status(500).json({ error: 'AI 이미지 생성에 실패했습니다. 서버 로그를 확인하세요.', details: error.message });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));