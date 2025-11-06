const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Multer 설정: 메모리에 임시 파일 저장 (AI 처리를 위해)
const upload = multer({ storage: multer.memoryStorage() });

// **[핵심 경로 설정]** public 폴더의 파일들을 웹에서 접근 가능하도록 설정
app.use(express.static(path.join(__dirname, 'public')));
// AI 결과 이미지를 저장할 폴더 (images)도 웹에서 접근 가능하게 설정
app.use('/images', express.static(path.join(__dirname, 'images')));

// AI 처리 API 엔드포인트
app.post('/api/ai-process', upload.single('image'), async (req, res) => {
    const uploadedFile = req.file;
    const { prompt, style } = req.body;

    if (!uploadedFile) {
        return res.status(400).json({ error: '이미지 파일이 누락되었습니다.' });
    }

    try {
        // [구현 필요] 이곳에 실제 AI 모델 호출 로직을 넣어야 합니다.
        // 현재는 더미 이미지 URL을 반환한다고 가정합니다.

        const aiImageBuffer = Buffer.from("DUMMY IMAGE DATA"); // 실제로는 AI 모델 결과

        // 1. 이미지 저장 (images 폴더에 저장)
        const finalFileName = `ai_result_${Date.now()}.png`;
        const savePath = path.join(__dirname, 'images', finalFileName);

        // **실제 AI 이미지 데이터로 교체해야 함**
        // fs.writeFileSync(savePath, aiImageBuffer);

        // 2. 웹에서 접근 가능한 URL 반환
        const aiImageUrl = `/images/DUMMY_RESULT.png`; // 예시: 실제 결과 이미지로 교체 필요

        res.json({ aiImageUrl: aiImageUrl });

    } catch (error) {
        console.error('AI 처리 중 오류 발생:', error);
        res.status(500).json({ error: 'AI 이미지 생성에 실패했습니다. 서버 로그 확인.' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});