// server.js

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs'); // 파일 시스템 동기/비동기 처리를 위해 사용
const { v4: uuidv4 } = require('uuid');

const { OpenAI } = require('openai');
const fetch = require('node-fetch');

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
// 보조 함수: 이미지를 Base64로 인코딩 (Vision API 사용을 위해 필요)
// ===================================================
function imageToBase64(filePath) {
    try {
        // 비동기 환경에서 동기 처리 (작은 파일이므로 성능 문제 크지 않음)
        return fs.readFileSync(filePath).toString('base64');
    } catch (e) {
        console.error("파일 읽기 오류:", e);
        return null;
    }
}

// ===================================================
// PC-모바일 브리지 API (유지)
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
// AI 처리 API (GPT-4o Vision 및 DALL-E 3 통합)
// ===================================================
app.post('/api/ai-process', upload.single('pcImage'), async (req, res) => {
    const { prompt, style, mode, qrUploadedFileName } = req.body;
    let inputImagePath = null;
    let basePrompt = prompt;

    try {
        if (mode === 'image' && req.file) {
            inputImagePath = req.file.path;
        } else if (mode === 'qr' && qrUploadedFileName) {
            inputImagePath = path.join(UPLOADS_PATH, qrUploadedFileName);
        } else if (mode === 'text') {
            // 텍스트 모드는 파일 필요 없음
        } else {
            return res.status(400).json({ error: '필수 입력 데이터가 부족하거나 모드가 일치하지 않습니다.' });
        }

        // --- [핵심] GPT-4o Vision을 사용한 이미지 분석 (Image-to-Image 모드) ---
        if ((mode === 'image' || mode === 'qr') && inputImagePath) {

            const base64Image = imageToBase64(inputImagePath);
            if (!base64Image) {
                return res.status(500).json({ error: '이미지 파일을 읽을 수 없습니다.' });
            }

            // 1. GPT-4o Vision API 호출
            const visionResponse = await openai.chat.completions.create({
                model: "gpt-4o", // Vision 분석을 위해 GPT-4o 사용
                messages: [
                    {
                        role: "system",
                        content: "You are an expert AI image analyzer. Describe the main subject, composition, background, lighting, and primary colors of the uploaded photo in one detailed English text prompt (under 100 words). Do not include any stylistic or artistic instructions (e.g., oil painting, animation style). This description will be the base for an image generation model.",
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze the uploaded photo and describe it." },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Image}`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 300,
            });

            const visionDescription = visionResponse.choices[0].message.content.trim();

            // 2. Vision 분석 결과와 사용자 프롬프트를 결합
            // 원본의 특징을 살리기 위해 Vision 결과를 프롬프트 맨 앞에 배치
            basePrompt = `(Original Content Description: ${visionDescription}). User request: ${basePrompt}`;

            // Image-to-Image 시뮬레이션을 위해 프롬프트 길이를 확보합니다.
        }

        // --- DALL-E 3 이미지 생성 (최종 프롬프트 구성) ---

        // 최종 프롬프트 구성
        let finalPrompt = `${basePrompt}. Convert it into ${style} style. Highly detailed and professional quality.`;

        // 3. DALL-E 3 API 호출
        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: finalPrompt,
            n: 1,
            size: "1024x1024",
            response_format: 'url',
        });

        const imageUrl = response.data[0].url;

        // 4. 생성된 이미지 다운로드 및 저장
        const imageResponse = await fetch(imageUrl);

        if (!imageResponse.ok) {
            throw new Error(`Failed to download image from OpenAI URL: ${imageResponse.statusText}`);
        }

        const aiImageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        const finalFileName = `ai_result_${uuidv4()}.png`;
        const finalSavePath = path.join(IMAGES_PATH, finalFileName);

        fs.writeFileSync(finalSavePath, aiImageBuffer);

        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생 (server.js):', error);

        let errorMessage = 'AI 이미지 생성에 실패했습니다. (서버 오류)';

        // 정책 위반 에러 감지 및 사용자 친화적인 메시지 반환
        if (error.code === 'content_policy_violation' || error.status === 400 && error.error && error.error.code === 'content_policy_violation') {
            errorMessage = '⚠️ 콘텐츠 정책 위반: 입력하신 내용이 OpenAI의 안전 시스템에 의해 거부되었습니다. 프롬프트 내용을 구체적이고 안전하게 수정해주세요.';
        }

        res.status(500).json({
            error: errorMessage,
            details: error.message
        });
    }
});

// ===================================================
// 다운로드 강제 API (유지)
// ===================================================
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(IMAGES_PATH, filename);

    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(filePath);
    } else {
        res.status(404).send('다운로드할 파일을 찾을 수 없습니다.');
    }
});


app.listen(port, () => console.log(`Server running on port ${port}`));