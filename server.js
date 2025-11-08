// server.js

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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
const IMAGES_ROOT_PATH = path.join(__dirname, 'images');
const UPLOADS_PATH = path.join(IMAGES_ROOT_PATH, 'uploads');

// 폴더 생성
[IMAGES_ROOT_PATH, UPLOADS_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) {
        console.log(`Creating directory: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
    }
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
app.use('/images', express.static(IMAGES_ROOT_PATH));
app.use(express.static(PUBLIC_PATH));

app.use(express.json());

// ===================================================
// 보조 함수: 이미지를 Base64로 인코딩 (Vision API 사용을 위해 필요)
// ===================================================
function imageToBase64(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
    }[ext];

    if (!mimeType) {
        throw new Error(`지원하지 않는 파일 형식입니다: ${ext}`);
    }

    try {
        const fileBuffer = fs.readFileSync(filePath);
        return {
            base64: fileBuffer.toString('base64'),
            mimeType: mimeType
        };
    } catch (e) {
        console.error(`Base64 인코딩 중 오류 발생: ${filePath}`, e);
        throw new Error(`파일을 Base64로 인코딩할 수 없습니다: ${filePath}`);
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

    activeSessions[sessionId] = {
        status: 'uploaded',
        filePath: req.file.path,
        originalName: req.file.originalname,
        fileName: path.basename(req.file.path)
    };
    res.send(`<script>alert('파일 업로드 성공! PC 화면을 확인해주세요.'); setTimeout(function() { window.close(); }, 1000); </script><h1>업로드 성공</h1>`);
});

app.get('/api/check-upload-status/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeSessions[sessionId];
    if (!session) return res.status(404).json({ status: 'error', message: '세션 만료' });
    if (session.status === 'uploaded') {
        const fileInfo = { ...session };
        delete activeSessions[sessionId];
        return res.json({ status: 'uploaded', fileInfo: fileInfo });
    }
    res.json({ status: 'waiting' });
});

// ===================================================
// AI 처리 API (프롬프트 최적화)
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

        let visionDescription = "";

        // --- GPT-4o Vision을 사용한 이미지 분석 ---
        if ((mode === 'image' || mode === 'qr') && inputImagePath) {

            const { base64, mimeType } = imageToBase64(inputImagePath);

            // 1. GPT-4o Vision API 호출
            const visionResponse = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        // [수정] DALL-E에게 필요한 상세 묘사만 요청하며 인물 식별 정보 회피
                        content: "You are an expert AI image analyzer. Describe ONLY the core visual elements needed for image generation (composition, subject, pose, background, colors, lighting). Do NOT mention any style, art medium, or names. If the subject is a person, describe them ONLY as a 'character' or 'figure' and avoid specific identifiers.",
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze this photo and provide a concise, detailed description for style conversion." },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,${base64}`,
                                    detail: "high"
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 300,
            });

            visionDescription = visionResponse.choices[0].message.content.trim();
        }

        // --- DALL-E 3 이미지 생성 (프롬프트 재구성) ---

        let finalPrompt = basePrompt;

        if (mode === 'image' || mode === 'qr') {
            // [최종 최적화] DALL-E에게 '변환'을 강제하는 강력한 프롬프트 구조 사용
            finalPrompt =
                `Based on the content described: "${visionDescription}". ` +
                `The user wants to transform this exact composition into the requested style. ` +
                `Maintain the subject's pose, the overall composition, and the color scheme. ` +
                `Style: ${style}. User refinement: ${basePrompt}. Highly detailed, photorealistic quality.`;
        } else {
            // 텍스트 모드
            finalPrompt = `${basePrompt} in ${style} style. Highly detailed and cinematic quality.`;
        }

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
            throw new Error(`Failed to download image from OpenAI URL: ${imageResponse.statusText}. Status: ${imageResponse.status}`);
        }

        const aiImageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        const finalFileName = `ai_result_${uuidv4()}.png`;
        const finalSavePath = path.join(IMAGES_ROOT_PATH, finalFileName);

        fs.writeFileSync(finalSavePath, aiImageBuffer);

        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생 (server.js):', error);

        let errorMessage = 'AI 이미지 생성에 실패했습니다. (서버 오류)';

        // 정책 위반 에러 감지 및 사용자 친화적인 메시지 반환
        if (error.code === 'content_policy_violation' || (error.status === 400 && error.error && error.error.code === 'content_policy_violation')) {
            errorMessage = '⚠️ 콘텐츠 정책 위반: 입력하신 내용이나 분석된 이미지에 부적절한 내용이 포함되어 거부되었습니다. 원본 이미지나 프롬프트 내용을 확인해주세요.';
        } else if (error.message.includes('파일을 찾을 수 없습니다')) {
            errorMessage = '원본 이미지 처리 중 오류가 발생했습니다. 유효한 이미지 파일을 업로드했는지 확인해주세요.';
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
    const filePath = path.join(IMAGES_ROOT_PATH, filename);

    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(filePath);
    } else {
        console.error(`Download file not found: ${filePath}`);
        res.status(404).send('다운로드할 파일을 찾을 수 없습니다.');
    }
});


app.listen(port, () => console.log(`Server running on port ${port}`));