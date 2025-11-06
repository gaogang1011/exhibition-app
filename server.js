// server.js (Node.js/Express)

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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
    // pcImage는 PC 업로드 모드에서만 req.file로 들어옵니다.
    const { prompt, style, mode, qrUploadedFileName } = req.body;
    let inputImagePath = null;

    try {
        if (mode === 'image' && req.file) { // 1. PC 업로드 Image to Image
            inputImagePath = req.file.path;
        } else if (mode === 'qr' && qrUploadedFileName) { // 3. QR 업로드 Image to Image
            inputImagePath = path.join(UPLOADS_PATH, qrUploadedFileName);
        } else if (mode === 'text') { // 2. Text to Image
            // 파일 입력 필요 없음
        } else {
            return res.status(400).json({ error: '필수 입력 데이터가 부족하거나 모드가 일치하지 않습니다.' });
        }

        // [AI 처리 가상화]
        console.log(`AI 요청 모드: ${mode}, 프롬프트: ${prompt}, 파일 경로: ${inputImagePath}`);
        const aiImageBuffer = Buffer.from(`AI RESULT FOR ${prompt}`, 'utf8');

        // AI 결과 이미지 저장
        const finalFileName = `ai_result_${uuidv4()}.png`;
        const finalSavePath = path.join(IMAGES_PATH, finalFileName);

        // fs.writeFileSync(finalSavePath, aiImageBuffer); // 실제 AI 이미지 저장
        fs.writeFileSync(finalSavePath, 'DUMMY AI RESULT', 'utf8'); // 테스트용

        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류:', error);
        res.status(500).json({ error: 'AI 이미지 생성에 실패했습니다.' });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));