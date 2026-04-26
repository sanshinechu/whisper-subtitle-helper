# Whisper 字幕神器

這是一個可以部署到 GitHub Pages 的瀏覽器版 Whisper 字幕工具。使用者上傳音訊或影片後，程式會在本機瀏覽器中辨識語音，並輸出 UTF-8 BOM 的 `.srt` 字幕檔。

## 使用方式

1. 開啟 `index.html`
2. 上傳 `mp3`、`wav`、`m4a`、`mp4`、`ogg` 或 `webm`
3. 等待模型下載與辨識完成
4. 按「下載 SRT」

第一次使用會從 Hugging Face 下載 Whisper 模型，之後瀏覽器通常會自動快取。

## YouTube 影片下載

GitHub Pages 本身不能執行 Python 或 Node.js 後端，所以 YouTube 下載功能需要搭配本機字幕助手。

第一次使用：

1. 先安裝 Python 3.11 以上版本
2. 到 `local-helper` 資料夾
3. 雙擊 `雙擊啟動本機助手.bat`
4. 等待套件安裝完成
5. 視窗顯示 `http://127.0.0.1:8765` 後不要關閉
6. 回到網頁按「檢查本機助手」
7. 貼上 YouTube 網址並確認影片使用權限

如果啟動失敗，視窗會停在錯誤訊息畫面，請把畫面截圖提供給協助者。

下載完成的影片會放在 `local-helper/downloads`。完成後，請把影片拖到上傳區產生字幕。

請只下載自己的影片、已取得授權的影片，或平台明確允許下載的內容。

## 部署到 GitHub Pages

1. 在 GitHub 建立新 repository
2. 上傳本專案所有檔案
3. 到 repository 的 `Settings` → `Pages`
4. `Build and deployment` 選擇 `Deploy from a branch`
5. Branch 選 `main`，資料夾選 `/root`
6. 等待 GitHub 產生網址

## 注意事項

- GitHub Pages 只能執行前端網頁，所以模型會在使用者自己的瀏覽器中執行。
- 大型影片需要較久時間，也會吃比較多記憶體。
- 建議使用最新版 Chrome 或 Edge。
- 若瀏覽器支援 WebGPU，速度會比 CPU 模式快。
