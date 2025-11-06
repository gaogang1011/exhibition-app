const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// [경로 수정] public 폴더 및 images 폴더 경로 설정
const PUBLIC_PATH = path.join(__dirname, 'public');
const IMAGES_PATH = path.join(__dirname, 'images');

// images 폴더가 없으면 생성 (AI 결과 저장을 위해)
if (!fs.existsSync(IMAGES_PATH)) {
    fs.mkdirSync(IMAGES_PATH);
}

// Multer 설정: 메모리에 임시 파일 저장
const upload = multer({ storage: multer.memoryStorage() });

// [오류 해결] public 폴더의 파일들을 웹에서 접근 가능하도록 설정
app.use(express.static(PUBLIC_PATH));
// [오류 해결] images 폴더도 웹에서 접근 가능하게 설정
app.use('/images', express.static(IMAGES_PATH));

// AI 처리 API 엔드포인트
app.post('/api/ai-process', upload.single('image'), async (req, res) => {
    const uploadedFile = req.file;
    const { prompt, style, mode } = req.body;

    // Text to Image 모드에서는 파일이 없을 수 있음
    if (mode === 'image' && !uploadedFile) {
        return res.status(400).json({ error: '이미지 변환 모드: 이미지 파일이 누락되었습니다.' });
    }
    if (!prompt) {
        return res.status(400).json({ error: '프롬프트(설명)이 누락되었습니다.' });
    }

    try {
        // [구현 필요] 이곳에 실제 AI 모델 호출 로직을 넣어야 합니다.
        // **실제 AI 모델을 호출하여 이미지 데이터(Buffer)를 받아야 합니다.**

        let aiImageBuffer;

        if (mode === 'text') {
            // Text to Image 모델 호출
            // aiImageBuffer = await callTextToImageAI(prompt, style);
            aiImageBuffer = Buffer.from("DUMMY IMAGE FOR TEXT TO IMAGE", 'utf8'); // 임시
        } else { // image mode (Image to Image)
            // Image to Image 모델 호출: uploadedFile.buffer와 prompt 사용
            // aiImageBuffer = await callImageToImageAI(uploadedFile.buffer, prompt, style);
            aiImageBuffer = Buffer.from("DUMMY IMAGE FOR IMAGE TO IMAGE", 'utf8'); // 임시
        }

        // 1. 이미지 저장
        const finalFileName = `ai_result_${Date.now()}.png`;
        const savePath = path.join(IMAGES_PATH, finalFileName);

        // **[오류 해결] 실제 파일 저장 (fs.writeFileSync에 실제 AI 이미지 데이터(aiImageBuffer)를 사용해야 함)**
        // 현재는 fs.writeFileSync(savePath, aiImageBuffer); 가 작동하도록 구조화만 해둡니다.
        // 테스트를 위해 임시로 빈 파일 생성:
        fs.writeFileSync(savePath, 'TEST IMAGE', 'utf8');

        // 2. 웹에서 접근 가능한 URL 반환
        // [오류 해결] /images/ 경로를 사용하여 프론트엔드에서 접근 가능하게 합니다.
        const aiImageUrl = `/images/${finalFileName}`;

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생:', error);
        res.status(500).json({ error: 'AI 이미지 생성에 실패했습니다. 서버 로그 확인.' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});