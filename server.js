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
const IMAGES_ROOT_PATH = path.join(__dirname, 'images'); // images 폴더 루트
const UPLOADS_PATH = path.join(IMAGES_ROOT_PATH, 'uploads'); // 업로드된 원본 이미지 저장

// 폴더 생성
[IMAGES_ROOT_PATH, UPLOADS_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) {
        console.log(`Creating directory: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Multer 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_PATH), // 업로드 폴더 지정
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// 세션 관리 객체
const activeSessions = {};

// [정적 파일 서빙]
// /images 경로로 들어오는 요청은 images/ 폴더에서 파일을 찾습니다.
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
    try {
        return fs.readFileSync(filePath).toString('base64');
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
        if (err) {
            console.error('Error reading upload.html:', err);
            return res.status(500).send('서버 오류: 폼을 로드할 수 없습니다.');
        }
        res.send(data);
    });
});

app.post('/api/mobile-upload/:sessionId', upload.single('mobileImage'), (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeSessions[sessionId];
    if (!session) return res.status(404).send('유효하지 않거나 만료된 세션 ID입니다.');
    if (!req.file) return res.status(400).send('업로드된 파일이 없습니다.');

    // 파일 경로를 activeSessions에 저장할 때, 이미 'uploads' 서브폴더에 저장되므로
    // Vision API에서 직접 읽을 수 있는 전체 경로를 저장합니다.
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
        // 세션 완료 후 바로 삭제
        const fileInfo = { ...session }; // 파일 정보를 복사하여 반환
        delete activeSessions[sessionId];
        return res.json({ status: 'uploaded', fileInfo: fileInfo });
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
            inputImagePath = req.file.path; // PC 업로드 파일 경로
        } else if (mode === 'qr' && qrUploadedFileName) {
            inputImagePath = path.join(UPLOADS_PATH, qrUploadedFileName); // QR 업로드 파일 경로
        } else if (mode === 'text') {
            // 텍스트 모드는 파일 필요 없음
        } else {
            return res.status(400).json({ error: '필수 입력 데이터가 부족하거나 모드가 일치하지 않습니다.' });
        }

        // --- [핵심] GPT-4o Vision을 사용한 이미지 분석 (Image-to-Image 모드) ---
        if ((mode === 'image' || mode === 'qr') && inputImagePath) {
            console.log(`Analyzing image with Vision API: ${inputImagePath}`);

            const base64Image = imageToBase64(inputImagePath); // Base64 인코딩
            // imageToBase64 함수에서 예외를 던지므로 여기서는 null 체크 필요 없음

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
                            { type: "text", text: "Analyze the uploaded photo and describe it concisely." },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Image}`,
                                    detail: "high" // 고화질 분석 요청
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 300,
            });

            const visionDescription = visionResponse.choices[0].message.content.trim();
            console.log("Vision Description:", visionDescription);

            // 2. Vision 분석 결과와 사용자 프롬프트를 결합
            // 원본의 특징을 살리기 위해 Vision 결과를 프롬프트 맨 앞에 배치
            // 사용자의 추가 프롬프트가 있다면 함께 포함 (예: '원본을 유지하면서, 강아지가 웃는 모습으로')
            basePrompt = `(Based on a photo of: ${visionDescription}). User's additional request: ${basePrompt}`;

        }

        // --- DALL-E 3 이미지 생성 (최종 프롬프트 구성) ---

        // 최종 프롬프트 구성
        let finalPrompt = `${basePrompt}. Convert it into ${style} style. Highly detailed and professional quality.`;
        if (style === 'default' || !style) { // 스타일이 'default'거나 없을 경우
            finalPrompt = `${basePrompt}. Highly detailed and professional quality.`;
        }

        console.log("Final DALL-E Prompt:", finalPrompt); // 최종 프롬프트 로깅

        // 3. DALL-E 3 API 호출
        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: finalPrompt,
            n: 1,
            size: "1024x1024",
            response_format: 'url',
        });

        const imageUrl = response.data[0].url;
        console.log("Generated AI Image URL:", imageUrl); // DALL-E에서 받은 이미지 URL 로깅

        // 4. 생성된 이미지 다운로드 및 저장
        const imageResponse = await fetch(imageUrl);

        if (!imageResponse.ok) {
            throw new Error(`Failed to download image from OpenAI URL: ${imageResponse.statusText}. Status: ${imageResponse.status}`);
        }

        const aiImageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // AI 결과 이미지는 'images' 폴더 바로 아래에 저장 (uploads와 구분)
        const finalFileName = `ai_result_${uuidv4()}.png`;
        const finalSavePath = path.join(IMAGES_ROOT_PATH, finalFileName);

        fs.writeFileSync(finalSavePath, aiImageBuffer);
        console.log(`AI result saved to: ${finalSavePath}`);

        // 클라이언트에게 반환할 URL은 /images/ 폴더를 기준으로 합니다.
        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생 (server.js):', error);

        let errorMessage = 'AI 이미지 생성에 실패했습니다. (서버 오류)';

        // 정책 위반 에러 감지 및 사용자 친화적인 메시지 반환
        if (error.code === 'content_policy_violation' || (error.status === 400 && error.error && error.error.code === 'content_policy_violation')) {
            errorMessage = '⚠️ 콘텐츠 정책 위반: 입력하신 내용이 OpenAI의 안전 시스템에 의해 거부되었습니다. 프롬프트 내용을 구체적이고 안전하게 수정해주세요.';
        } else if (error.message.includes('Failed to download image from OpenAI URL')) {
            errorMessage = 'AI 이미지를 다운로드하는 데 실패했습니다. 다시 시도해 주세요.';
        } else if (error.message.includes('파일을 찾을 수 없습니다') || error.message.includes('파일을 Base64로 인코딩할 수 없습니다')) {
            errorMessage = '원본 이미지 처리 중 오류가 발생했습니다. 유효한 이미지 파일을 업로드했는지 확인해주세요.';
        }

        res.status(500).json({
            error: errorMessage,
            details: error.message
        });
    } finally {
        // [클린업] 업로드된 원본 이미지는 AI 처리 후 삭제 (선택 사항)
        // inputImagePath가 존재하고, DALL-E 처리 중 에러가 발생하지 않았다면 삭제할 수 있습니다.
        // 하지만 디버깅을 위해 일단 주석 처리하여 유지할 수 있도록 합니다.
        // if (inputImagePath && fs.existsSync(inputImagePath)) {
        //     fs.unlink(inputImagePath, (err) => {
        //         if (err) console.error("Error deleting uploaded file:", err);
        //     });
        // }
    }
});

// ===================================================
// 다운로드 강제 API (유지)
// ===================================================
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(IMAGES_ROOT_PATH, filename); // images 루트 폴더에서 찾도록 변경

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