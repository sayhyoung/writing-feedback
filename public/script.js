const { jsPDF } = window.jspdf;
const API_BASE_URL = 'https://us-central1-writeback-462607.cloudfunctions.net';
function generatePDFFileName(userName) {
    const today = new Date();
    const dateStr = today.getFullYear() +
        String(today.getMonth() + 1).padStart(2, '0') +
        String(today.getDate()).padStart(2, '0');
    return userName?.trim() ? `${userName.trim()}_WriteBack_${dateStr}` : `Writing_${dateStr}`;
}

// PDF 파일명 생성 함수
document.addEventListener('DOMContentLoaded', () => {
    // 전역 변수 초기화
    window.feedbackFileURL = '';
    window.finalFileURL = '';
    window.LOGO_DATA_URI = '';

    // 인쇄/PDF에 임베드할 로고를 base64로 미리 로딩 (외부 요청 지연 회피)
    fetch('logo.png')
        .then(r => r.ok ? r.blob() : null)
        .then(blob => {
            if (!blob) return;
            const reader = new FileReader();
            reader.onload = () => { window.LOGO_DATA_URI = reader.result; };
            reader.readAsDataURL(blob);
        })
        .catch(() => {});

    function formatDateKR(d = new Date()) {
        return `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}.`;
    }

    // 쉐도잉용 캐시 (한 번 받은 MP3 + timepoints 재사용)
    // text: 음원의 원본(수정글) 텍스트, rateCache: 다운로드용 속도별 재생성 결과 캐시
    let shadowingCache = { audioUrl: null, timepoints: [], sentences: [], text: '', rateCache: {} };
    function clearShadowingCache() {
        if (shadowingCache.audioUrl) URL.revokeObjectURL(shadowingCache.audioUrl);
        shadowingCache = { audioUrl: null, timepoints: [], sentences: [], text: '', rateCache: {} };
    }

    // 다운로드용 속도(speakingRate)별 TTS 재생성 결과를 받아 캐시 (반복 호출 비용 방지)
    async function getTTSForRate(rate) {
        const key = String(rate);
        if (shadowingCache.rateCache[key]) return shadowingCache.rateCache[key];
        const text = shadowingCache.text;
        if (!text) throw new Error('음원 원본 텍스트가 없습니다.');
        const res = await fetch(`${API_BASE_URL}/ttsFunction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, speakingRate: rate })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || '음원 생성 실패');
        }
        const data = await res.json();
        const entry = {
            audioBase64: data.audioBase64,
            timepoints: Array.isArray(data.timepoints) ? data.timepoints : [],
            sentences: Array.isArray(data.sentences) ? data.sentences : [],
        };
        shadowingCache.rateCache[key] = entry;
        return entry;
    }

    // ===== IndexedDB: 로컬 "내 결과물" 보관함 =====
    const HISTORY_DB = 'writeback-history';
    const HISTORY_STORE = 'results';
    let currentResultId = null; // 현재 화면에 표시 중인 최종 결과의 저장 id

    function openHistoryDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(HISTORY_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(HISTORY_STORE)) {
                    db.createObjectStore(HISTORY_STORE, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function historyAdd(record) {
        const db = await openHistoryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readwrite');
            const req = tx.objectStore(HISTORY_STORE).add(record);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function historyUpdate(id, patch) {
        if (id == null) return;
        const db = await openHistoryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readwrite');
            const store = tx.objectStore(HISTORY_STORE);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const rec = getReq.result;
                if (!rec) { resolve(); return; }
                Object.assign(rec, patch);
                const putReq = store.put(rec);
                putReq.onsuccess = () => resolve();
                putReq.onerror = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }
    async function historyGetAll() {
        const db = await openHistoryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readonly');
            const req = tx.objectStore(HISTORY_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }
    async function historyGet(id) {
        const db = await openHistoryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readonly');
            const req = tx.objectStore(HISTORY_STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }
    async function historyDelete(id) {
        const db = await openHistoryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(HISTORY_STORE, 'readwrite');
            const req = tx.objectStore(HISTORY_STORE).delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // --- 헬퍼 함수들 ---


 /**
     * ✅ 기기가 안드로이드인지 확인하는 헬퍼 함수
     */
    function isAndroid() {
        return /android/i.test(navigator.userAgent);
    }


    // 텍스트 정리 함수
    function cleanExtractedText(text) {
        if (!text || typeof text !== 'string') return '';
        text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
        text = text.split('\n').map(line => line.trim()).join('\n');
        return text.trim();
    }

    // 이미지 전처리 함수
    function preprocessImage(canvas, ctx) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const contrast = 1.2;
        const brightness = 10;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, Math.max(0, contrast * (data[i] - 128) + 128 + brightness));
            data[i + 1] = Math.min(255, Math.max(0, contrast * (data[i + 1] - 128) + 128 + brightness));
            data[i + 2] = Math.min(255, Math.max(0, contrast * (data[i + 2] - 128) + 128 + brightness));
        }
        ctx.putImageData(imageData, 0, 0);
    }

    // OCR 함수
    async function doOCR(file, section) {
        const status = document.getElementById(`ocr-status-${section}`);
        const textArea = document.getElementById(`contentText-${section}`);
        
        if (!status || !textArea) {
            console.error(`Required elements not found for section: ${section}`);
            return;
        }

        status.classList.add('show');

        try {
            if (file.size > 10 * 1024 * 1024) throw new Error('파일 크기가 10MB를 초과합니다.');
            if (!file.type.startsWith('image/')) throw new Error('이미지 파일만 업로드 가능합니다.');

            const img = new Image();
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            await new Promise((resolve, reject) => {
                img.onload = () => {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    preprocessImage(canvas, ctx);
                    resolve();
                };
                img.onerror = reject;
                img.src = URL.createObjectURL(file);
            });

            const fullDataUrl = canvas.toDataURL('image/jpeg', 0.95);

            const resp = await fetch(`${API_BASE_URL}/ocrFunction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: fullDataUrl })
            });

            if (!resp.ok) {
                const errorData = await resp.json().catch(() => ({ error: resp.statusText }));
                throw new Error(`API 오류: ${errorData.error || resp.statusText}`);
            }

            const data = await resp.json();
            textArea.value = cleanExtractedText(data.text || '텍스트를 인식할 수 없습니다.');
        } catch (error) {
            console.error('OCR 오류:', error);
            textArea.value = `OCR 처리 중 오류: ${error.message}`;
        } finally {
            status.classList.remove('show');
        }
    }

    function escapeHTML(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function highlightQuotes(s) {
        return s
            .replace(/"([^"\n]+?)"/g, '<span class="fb-quote">"$1"</span>')
            .replace(/'([^'\n]+?)'/g, '<span class="fb-quote">‘$1’</span>');
    }

    // 모델이 markdown을 출력할 경우 HTML로 변환 (서버 프롬프트가 금지하지만 안전망)
    function renderMarkdownContent(text) {
        if (!text || typeof text !== 'string') return '';
        let html = escapeHTML(text)
            .replace(/^\s*\*\*\s*$/gm, '')                       // 짝 없는 빈 줄의 **만 있는 라인 제거
            .replace(/\*\*([^\*\n]+?)\*\*/g, '<strong>$1</strong>') // **bold**
            .replace(/^[ \t]*[\*\-][ \t]+/gm, '• ')              // * 또는 - 불릿 → •
            .replace(/^[ \t]*#+[ \t]+/gm, '');                   // # 헤더 마커 제거
        html = highlightQuotes(html);
        return html.replace(/\n/g, '<br>');
    }

    // 원문 / 설명 / 수정 제안 구조를 카드로 렌더 (없으면 null 반환 → 폴백)
    function renderStructuredItems(text) {
        if (!text || typeof text !== 'string') return null;
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const items = [];
        let cur = null;
        let lastKey = null;
        const startRe = /^(\d+)[.)]\s*(?:원문|문장|예시)\s*:\s*(.*)$/;
        const labelRe = {
            '원문': /^(?:원문|문장|예시)\s*:\s*(.*)$/,
            '설명': /^(?:설명|이유|문제점)\s*:\s*(.*)$/,
            '수정': /^(?:수정\s*제안|수정|개선|대안|제안)\s*:\s*(.*)$/,
        };

        for (const line of lines) {
            const m = line.match(startRe);
            if (m) {
                if (cur) items.push(cur);
                cur = { num: m[1], 원문: m[2], 설명: '', 수정: '' };
                lastKey = '원문';
                continue;
            }
            let matched = false;
            for (const [k, re] of Object.entries(labelRe)) {
                const lm = line.match(re);
                if (lm) {
                    if (!cur) cur = { num: items.length + 1, 원문: '', 설명: '', 수정: '' };
                    cur[k] = lm[1];
                    lastKey = k;
                    matched = true;
                    break;
                }
            }
            if (matched) continue;
            if (cur && lastKey) {
                cur[lastKey] += (cur[lastKey] ? ' ' : '') + line;
            } else {
                return null; // 구조 미발견 → 폴백
            }
        }
        if (cur) items.push(cur);
        if (items.length === 0) return null;
        // 최소한 원문/수정 중 하나는 채워져 있는지 확인 (아니면 구조가 아님)
        if (!items.some(it => it.원문 || it.수정)) return null;

        return items.map(it => `
            <div class="fb-item">
                <div class="fb-num">${it.num}</div>
                <div class="fb-rows">
                    ${it.원문 ? `<div class="fb-row"><span class="fb-tag fb-tag-error">❌ 원문</span><span class="fb-content">${highlightQuotes(escapeHTML(it.원문))}</span></div>` : ''}
                    ${it.설명 ? `<div class="fb-row"><span class="fb-tag fb-tag-info">💡 설명</span><span class="fb-content">${highlightQuotes(escapeHTML(it.설명))}</span></div>` : ''}
                    ${it.수정 ? `<div class="fb-row"><span class="fb-tag fb-tag-correct">✨ 수정</span><span class="fb-content">${highlightQuotes(escapeHTML(it.수정))}</span></div>` : ''}
                </div>
            </div>
        `).join('');
    }

    function renderFeedbackContent(text) {
        const structured = renderStructuredItems(text);
        if (structured) return structured;
        return renderMarkdownContent(text);
    }

    // 상세 피드백 파싱 함수
    function processFeedback(feedback) {
        if (!feedback || typeof feedback !== 'string') return '<p>피드백을 처리할 수 없습니다.</p>';
        const patterns = {
            '총평': { pattern: /(?:총평|전체\s*평가|종합\s*평가)[\s]*:([\s\S]*?)(?=(?:문법\s*오류|어휘\s*개선|표현\s*향상|잘한\s*점)\s*:|$)/i, icon: 'fa-star', color: 'overview-category' },
            '문법 오류': { pattern: /문법\s*오류\s*:([\s\S]*?)(?=(?:총평|어휘\s*개선|표현\s*향상|잘한\s*점)\s*:|$)/i, icon: 'fa-exclamation-circle', color: 'grammar' },
            '어휘 개선': { pattern: /어휘\s*개선\s*:([\s\S]*?)(?=(?:총평|문법\s*오류|표현\s*향상|잘한\s*점)\s*:|$)/i, icon: 'fa-book', color: 'vocabulary' },
            '표현 향상': { pattern: /표현\s*향상\s*:([\s\S]*?)(?=(?:총평|문법\s*오류|어휘\s*개선|잘한\s*점)\s*:|$)/i, icon: 'fa-pencil-alt', color: 'expression' },
            '잘한 점': { pattern: /잘한\s*점\s*:([\s\S]*?)(?=(?:총평|문법\s*오류|어휘\s*개선|표현\s*향상)\s*:|$)/i, icon: 'fa-thumbs-up', color: 'strengths' }
        };

        let html = '<div class="feedback-container">';
        for (const [title, { pattern, icon, color }] of Object.entries(patterns)) {
            const match = feedback.match(pattern);
            if (match && match[1] && match[1].trim()) {
                // 캡처 컨텐츠 앞뒤 ** 마커 제거 후 구조화 렌더 시도
                const cleaned = match[1].trim()
                    .replace(/^\*+\s*/, '')
                    .replace(/\s*\*+$/, '');
                html += `
                    <div class="feedback-category ${color}">
                        <h3><i class="fas ${icon}"></i> ${title}</h3>
                        <div class="fb-section-body">${renderFeedbackContent(cleaned)}</div>
                    </div>
                `;
            }
        }
        html += '</div>';
        return html;
    }

// EXIF 정보를 읽어 이미지를 올바르게 회전시키는 함수 (용량 최적화)
function getRotatedImageForPrint(file) {
    return new Promise((resolve) => {
        if (!file) {
            resolve(null);
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    
                    // 최대 크기 제한 (용량 최적화)
                    const maxDimension = 1200;
                    let width = img.width;
                    let height = img.height;
                    
                    // 큰 이미지인 경우 크기 조정
                    if (width > maxDimension || height > maxDimension) {
                        if (width > height) {
                            height = (height * maxDimension) / width;
                            width = maxDimension;
                        } else {
                            width = (width * maxDimension) / height;
                            height = maxDimension;
                        }
                    }

                    // EXIF 라이브러리가 로드되어 있는지 확인
                    if (typeof EXIF !== 'undefined') {
                        EXIF.getData(img, function() {
                            const orientation = EXIF.getTag(this, "Orientation") || 1;

                            // EXIF 방향에 따라 캔버스 크기 조정
                            if (orientation >= 5 && orientation <= 8) {
                                canvas.width = height;
                                canvas.height = width;
                            } else {
                                canvas.width = width;
                                canvas.height = height;
                            }

                            // 캔버스 변환
                            switch (orientation) {
                                case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
                                case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
                                case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
                                case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
                                case 6: ctx.transform(0, 1, -1, 0, height, 0); break;
                                case 7: ctx.transform(0, -1, -1, 0, height, width); break;
                                case 8: ctx.transform(0, -1, 1, 0, 0, width); break;
                                default: ctx.transform(1, 0, 0, 1, 0, 0);
                            }

                            ctx.drawImage(img, 0, 0, width, height);
                            
                            // 압축률 높여서 용량 최적화
                            resolve(canvas.toDataURL('image/jpeg', 0.7));
                        });
                    } else {
                        // EXIF 라이브러리가 없는 경우
                        canvas.width = width;
                        canvas.height = height;
                        ctx.drawImage(img, 0, 0, width, height);
                        resolve(canvas.toDataURL('image/jpeg', 0.7));
                    }
                } catch (error) {
                    console.error('이미지 처리 오류:', error);
                    // 오류 시 기본 처리
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const width = Math.min(img.width, 1200);
                    const height = Math.min(img.height, 1200);
                    
                    canvas.width = width;
                    canvas.height = height;
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.7));
                }
            };
            img.onerror = () => resolve(null);
            img.src = e.target.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}



    // Edit/Save 로직 추가 함수
    function addEditSaveLogic(wrapperId, contentId) {
        const wrapper = document.getElementById(wrapperId);
        const content = document.getElementById(contentId);
        if (!wrapper || !content) return;
        
        // 기존 버튼 그룹이 있으면 제거
        const existingBtnGroup = wrapper.querySelector('.btn-group');
        if (existingBtnGroup) {
            existingBtnGroup.remove();
        }
        
        const btnGroup = document.createElement('div');
        btnGroup.className = 'btn-group';
        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.className = 'button';
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.className = 'button';
        saveBtn.style.display = 'none';
        
        btnGroup.append(editBtn, saveBtn);
        wrapper.append(btnGroup);

        editBtn.addEventListener('click', () => {
            content.contentEditable = 'true';
            content.style.outline = '2px solid #3b82f6';
            content.style.backgroundColor = '#eff6ff';
            content.focus();
            editBtn.style.display = 'none';
            saveBtn.style.display = 'inline-block';
        });
        
        saveBtn.addEventListener('click', () => {
            content.contentEditable = 'false';
            content.style.outline = 'none';
            content.style.backgroundColor = 'transparent';
            saveBtn.style.display = 'none';
            editBtn.style.display = 'inline-block';

            // 최종 수정글이 편집되면 보관함 기록도 갱신하고 음원 캐시는 무효화
            if (content.id === 'fn-corrected' && currentResultId != null) {
                historyUpdate(currentResultId, {
                    correctedText: content.innerText || '',
                    correctedHtml: content.innerHTML || '',
                    audioBase64: null,
                    timepoints: [],
                    sentences: [],
                }).catch(() => {});
            }
        });
    }

    function base64ToBlob(base64, mimeType) {
        const byteString = atob(base64);
        const bytes = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
    }

    // AudioBuffer의 일부 구간을 16-bit PCM WAV Blob으로 인코딩
    function audioBufferToWavBlob(buffer, startSec, endSec) {
        const sampleRate = buffer.sampleRate;
        const numCh = buffer.numberOfChannels;
        const startSample = Math.max(0, Math.floor(startSec * sampleRate));
        const endSample = Math.min(buffer.length, Math.floor(endSec * sampleRate));
        const frameCount = Math.max(0, endSample - startSample);

        const bytesPerSample = 2;
        const dataSize = frameCount * numCh * bytesPerSample;
        const headerSize = 44;
        const totalSize = headerSize + dataSize;
        const ab = new ArrayBuffer(totalSize);
        const view = new DataView(ab);

        let p = 0;
        function w8(s) { for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i)); }
        function w32(n) { view.setUint32(p, n, true); p += 4; }
        function w16(n) { view.setUint16(p, n, true); p += 2; }

        w8('RIFF'); w32(36 + dataSize); w8('WAVE');
        w8('fmt '); w32(16); w16(1); w16(numCh); w32(sampleRate);
        w32(sampleRate * numCh * bytesPerSample); w16(numCh * bytesPerSample); w16(16);
        w8('data'); w32(dataSize);

        // 채널별 Float32 → Interleaved Int16 변환
        const channels = [];
        for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
        for (let i = 0; i < frameCount; i++) {
            const sIdx = startSample + i;
            for (let ch = 0; ch < numCh; ch++) {
                let s = channels[ch][sIdx];
                if (s > 1) s = 1; else if (s < -1) s = -1;
                view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                p += 2;
            }
        }
        return new Blob([ab], { type: 'audio/wav' });
    }

    // 문장 텍스트 → 파일명 안전한 슬러그 (영문 단어 앞 4-5개)
    function slugifySentence(text) {
        if (!text) return 'sentence';
        const words = text.replace(/[^a-zA-Z0-9가-힣 ]/g, '').trim().split(/\s+/).slice(0, 5);
        const slug = words.join('_').replace(/[^a-zA-Z0-9_가-힣]/g, '').slice(0, 40);
        return slug || 'sentence';
    }

    // TTS 리스너 추가 함수
    function addTTSListener() {
        const ttsBtn = document.getElementById('tts-play-btn');
        if (!ttsBtn) return;

        const newTtsBtn = ttsBtn.cloneNode(true);
        ttsBtn.parentNode.replaceChild(newTtsBtn, ttsBtn);

        newTtsBtn.addEventListener('click', async () => {
            const playBtn = document.getElementById('tts-play-btn');
            const spinner = document.getElementById('tts-spinner');
            const correctedElement = document.getElementById('fn-corrected');

            if (!correctedElement) {
                alert('수정된 텍스트를 찾을 수 없습니다.');
                return;
            }

            playBtn.disabled = true;
            spinner.style.display = 'inline-block';

            try {
                const textFinal = correctedElement.innerText;
                const res = await fetch(`${API_BASE_URL}/ttsFunction`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: textFinal })
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: res.statusText }));
                    throw new Error(err.error || '음성 파일 생성 실패');
                }

                const data = await res.json();
                const blob = base64ToBlob(data.audioBase64, 'audio/mpeg');

                clearShadowingCache();
                const url = URL.createObjectURL(blob);
                const timepoints = Array.isArray(data.timepoints) ? data.timepoints : [];
                const sentences = Array.isArray(data.sentences) ? data.sentences : [];
                shadowingCache = {
                    audioUrl: url,
                    timepoints,
                    sentences,
                    text: textFinal,
                    // 기본 음원(speakingRate 0.9)을 다운로드 캐시에 시드 → 재호출 방지
                    rateCache: { '0.9': { audioBase64: data.audioBase64, timepoints, sentences } },
                };

                // 로컬 보관함에 음원 저장 (재처리 없이 재다운로드)
                historyUpdate(currentResultId, {
                    audioBase64: data.audioBase64,
                    timepoints,
                    sentences,
                }).catch(() => {});

                const audio = document.getElementById('tts-audio-final');
                const dlWrap = document.getElementById('tts-download-wrap');
                const shadowingBtn = document.getElementById('shadowing-open-btn');

                if (audio) {
                    audio.src = url;
                    audio.style.display = 'block';
                }
                if (dlWrap) dlWrap.style.display = 'flex';
                if (shadowingBtn && shadowingCache.sentences.length > 0) {
                    shadowingBtn.style.display = 'inline-block';
                }

                attachFullDownloadHandler();

            } catch (err) {
                alert('TTS 오류: ' + err.message);
            } finally {
                playBtn.disabled = false;
                spinner.style.display = 'none';
            }
        });
    }

    // 전체 음원 다운로드 — 선택한 속도(speakingRate)로 서버 재생성 후 저장
    function attachFullDownloadHandler() {
        const btn = document.getElementById('tts-download-btn');
        if (!btn || btn.dataset.wired === '1') return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
            const speedSel = document.getElementById('tts-dl-speed');
            const spinner = document.getElementById('tts-dl-spinner');
            const rate = parseFloat(speedSel?.value) || 0.9;
            btn.disabled = true;
            if (spinner) spinner.style.display = 'inline-block';
            try {
                const tts = await getTTSForRate(rate);
                const blob = base64ToBlob(tts.audioBase64, 'audio/mpeg');
                const url = URL.createObjectURL(blob);
                const name = document.getElementById('user-name-final')?.value || '';
                const a = document.createElement('a');
                a.href = url;
                a.download = `${generatePDFFileName(name)}_${rate}x.mp3`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
                alert('음원 다운로드 중 오류: ' + (err.message || err));
            } finally {
                btn.disabled = false;
                if (spinner) spinner.style.display = 'none';
            }
        });
    }

    function addShadowingListener() {
        const btn = document.getElementById('shadowing-open-btn');
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', openShadowingModal);
    }

    function openShadowingModal() {
        if (!shadowingCache.audioUrl || shadowingCache.sentences.length === 0) {
            alert('먼저 "원어민 음성 듣기"를 눌러 음성을 생성해주세요.');
            return;
        }

        const existing = document.getElementById('shadowing-modal');
        if (existing) existing.remove();

        const { sentences, timepoints, audioUrl } = shadowingCache;

        const rows = sentences.map((s, i) => `
            <li class="shadow-row" data-index="${i}">
                <button class="shadow-play" data-index="${i}" aria-label="문장 ${i + 1} 재생">▶</button>
                <span class="shadow-num">${i + 1}.</span>
                <span class="shadow-text">${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>
            </li>`).join('');

        const modal = document.createElement('div');
        modal.id = 'shadowing-modal';
        modal.className = 'shadow-overlay';
        modal.innerHTML = `
            <div class="shadow-dialog" role="dialog" aria-modal="true" aria-label="문장별 듣기">
                <div class="shadow-header">
                    <h3>🎧 문장별 듣기 (쉐도잉)</h3>
                    <button class="shadow-close" aria-label="닫기">&times;</button>
                </div>
                <div class="shadow-controls">
                    <label class="shadow-speed-label">속도
                        <select class="shadow-speed">
                            <option value="0.75">0.75x</option>
                            <option value="0.9">0.9x</option>
                            <option value="1" selected>1.0x</option>
                            <option value="1.15">1.15x</option>
                        </select>
                    </label>
                    <button class="shadow-play-all"><span class="shadow-pa-icon">▶</span> <span class="shadow-pa-label">전체 재생</span></button>
                </div>
                <p class="shadow-tip">💡 한 문장을 듣고 따라 말해보세요. 같은 버튼을 다시 누르면 정지됩니다.</p>
                <ul class="shadow-list">${rows}</ul>
                <div class="shadow-download-row">
                    <label class="dl-speed-label">다운로드 속도
                        <select class="shadow-dl-speed dl-speed-select">
                            <option value="0.7">느리게 (0.7x)</option>
                            <option value="0.8">약간 느리게 (0.8x)</option>
                            <option value="0.9" selected>보통 (0.9x)</option>
                            <option value="1.0">원어민 속도 (1.0x)</option>
                        </select>
                    </label>
                    <button class="shadow-download-btn">📥 문장별 음원 ZIP 다운로드<span class="shadow-download-spinner"></span></button>
                    <p class="dl-help">💡 파일은 기기의 '다운로드' 폴더(아이폰은 '파일' 앱)에 저장됩니다.</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        // Web Audio API — sample-accurate 재생 (모바일 seek 오차 해결)
        let audioCtx = null;
        let audioBuffer = null;
        let bufferReadyPromise = null;
        let activeSource = null;
        let activeStartCtxTime = 0;
        let activeBufferStart = 0;
        let activeBufferEnd = 0;
        let highlightInterval = null;
        let playbackRate = 1.0;
        let playingIndex = null; // null | number | 'all'
        let opToken = 0;
        let lastHighlightIdx = -1;

        // 반드시 사용자 제스처(click 핸들러) 안에서 동기적으로 호출되어야 iOS에서 동작
        function unlockAudioSync() {
            if (!audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) { alert('이 브라우저는 Web Audio API를 지원하지 않습니다.'); return false; }
                audioCtx = new AC();
                // iOS unlock: 1-sample silent buffer 재생으로 오디오 출력 활성화
                try {
                    const silent = audioCtx.createBuffer(1, 1, 22050);
                    const src = audioCtx.createBufferSource();
                    src.buffer = silent;
                    src.connect(audioCtx.destination);
                    src.start(0);
                } catch (_) {}
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            if (!bufferReadyPromise) {
                bufferReadyPromise = (async () => {
                    const resp = await fetch(audioUrl);
                    const arr = await resp.arrayBuffer();
                    return new Promise((resolve, reject) => {
                        audioCtx.decodeAudioData(arr, buf => {
                            audioBuffer = buf;
                            resolve(buf);
                        }, reject);
                    });
                })();
            }
            return true;
        }
        async function ensureBufferReady() {
            if (audioBuffer) return audioBuffer;
            if (!bufferReadyPromise) return null;
            return bufferReadyPromise;
        }

        function clearHighlight() {
            modal.querySelectorAll('.shadow-row').forEach(r => r.classList.remove('playing'));
            lastHighlightIdx = -1;
        }
        function highlightRow(idx) {
            modal.querySelectorAll('.shadow-row').forEach((r, i) => {
                r.classList.toggle('playing', i === idx);
            });
            lastHighlightIdx = idx;
        }
        function updateButtons() {
            modal.querySelectorAll('.shadow-play').forEach(b => {
                const idx = parseInt(b.dataset.index, 10);
                b.innerHTML = (playingIndex === idx) ? '⏹' : '▶';
            });
            const allBtn = modal.querySelector('.shadow-play-all');
            const isAll = (playingIndex === 'all');
            allBtn.querySelector('.shadow-pa-icon').textContent = isAll ? '⏹' : '▶';
            allBtn.querySelector('.shadow-pa-label').textContent = isAll ? '정지' : '전체 재생';
            allBtn.classList.toggle('active', isAll);
        }
        function stopActiveSource() {
            if (activeSource) {
                try { activeSource.onended = null; } catch (_) {}
                try { activeSource.stop(); } catch (_) {}
                try { activeSource.disconnect(); } catch (_) {}
                activeSource = null;
            }
            if (highlightInterval !== null) {
                clearInterval(highlightInterval);
                highlightInterval = null;
            }
        }
        function stopPlayback() {
            opToken++;
            stopActiveSource();
            playingIndex = null;
            clearHighlight();
            updateButtons();
        }
        function playRange(startSec, endSec, onNaturalEnd) {
            stopActiveSource();
            const dur = Math.max(0.05, endSec - startSec);
            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.playbackRate.value = playbackRate;
            source.connect(audioCtx.destination);
            source.onended = () => {
                if (activeSource === source && onNaturalEnd) onNaturalEnd();
            };
            activeSource = source;
            activeStartCtxTime = audioCtx.currentTime;
            activeBufferStart = startSec;
            activeBufferEnd = endSec;
            source.start(0, startSec, dur);
        }
        async function playSentence(i) {
            if (playingIndex === i) {
                stopPlayback();
                return;
            }
            const myToken = ++opToken;

            let buf;
            try { buf = await ensureBufferReady(); }
            catch (err) { console.error('디코딩 실패:', err); alert('오디오 디코딩 실패: ' + (err.message || err)); return; }
            if (myToken !== opToken) return;
            if (!buf || !audioCtx) return;

            const start = timepoints[i]?.timeSeconds ?? 0;
            const next = timepoints[i + 1]?.timeSeconds;
            const end = (typeof next === 'number') ? next : buf.duration;

            playingIndex = i;
            highlightRow(i);
            updateButtons();

            playRange(start, end, () => {
                if (playingIndex === i) stopPlayback();
            });
        }
        async function playAll() {
            if (playingIndex === 'all') {
                stopPlayback();
                return;
            }
            const myToken = ++opToken;

            let buf;
            try { buf = await ensureBufferReady(); }
            catch (err) { console.error('디코딩 실패:', err); alert('오디오 디코딩 실패: ' + (err.message || err)); return; }
            if (myToken !== opToken) return;
            if (!buf || !audioCtx) return;

            playingIndex = 'all';
            lastHighlightIdx = -1;
            updateButtons();
            highlightRow(0);

            playRange(0, buf.duration, () => {
                if (playingIndex === 'all') stopPlayback();
            });

            highlightInterval = setInterval(() => {
                if (!activeSource) return;
                const elapsed = (audioCtx.currentTime - activeStartCtxTime) * playbackRate;
                const t = activeBufferStart + elapsed;
                let idx = 0;
                for (let i = 0; i < timepoints.length; i++) {
                    if ((timepoints[i].timeSeconds ?? 0) <= t) idx = i;
                    else break;
                }
                if (idx !== lastHighlightIdx) highlightRow(idx);
            }, 80);
        }
        function closeModal() {
            stopPlayback();
            if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
            audioBuffer = null;
            bufferReadyPromise = null;
            document.body.style.overflow = '';
            modal.remove();
        }

        modal.querySelectorAll('.shadow-play').forEach(b => {
            b.addEventListener('click', e => {
                if (!unlockAudioSync()) return; // 동기 unlock — iOS gesture 요구사항
                const idx = parseInt(e.currentTarget.dataset.index, 10);
                playSentence(idx);
            });
        });
        modal.querySelector('.shadow-play-all').addEventListener('click', () => {
            if (!unlockAudioSync()) return;
            playAll();
        });
        modal.querySelector('.shadow-download-btn').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            if (btn.disabled) return;
            if (typeof window.JSZip === 'undefined') {
                alert('ZIP 라이브러리를 로드하지 못했습니다. 잠시 후 다시 시도해주세요.');
                return;
            }
            if (!unlockAudioSync()) return; // 디코딩 트리거 (audioCtx 생성)
            btn.disabled = true;
            const spinner = btn.querySelector('.shadow-download-spinner');
            if (spinner) spinner.classList.add('on');
            try {
                const rate = parseFloat(modal.querySelector('.shadow-dl-speed')?.value) || 0.9;
                // 선택 속도로 서버 재생성(캐시) → 해당 속도의 오디오/타임포인트로 분할
                const tts = await getTTSForRate(rate);
                const rateSentences = tts.sentences.length ? tts.sentences : sentences;
                const rateTimepoints = tts.timepoints.length ? tts.timepoints : timepoints;
                const blob = base64ToBlob(tts.audioBase64, 'audio/mpeg');
                const arr = await blob.arrayBuffer();
                const buf = await new Promise((resolve, reject) =>
                    audioCtx.decodeAudioData(arr, resolve, reject));
                if (!buf) throw new Error('오디오 버퍼가 준비되지 않았습니다.');
                const zip = new window.JSZip();
                for (let i = 0; i < rateSentences.length; i++) {
                    const start = rateTimepoints[i]?.timeSeconds ?? 0;
                    const next = rateTimepoints[i + 1]?.timeSeconds;
                    const end = (typeof next === 'number') ? next : buf.duration;
                    const wavBlob = audioBufferToWavBlob(buf, start, end);
                    const num = String(i + 1).padStart(2, '0');
                    const slug = slugifySentence(rateSentences[i]);
                    zip.file(`${num}_${slug}.wav`, wavBlob);
                }
                const userName = document.getElementById('user-name-final')?.value?.trim() || '';
                const zipName = `${generatePDFFileName(userName)}_문장별음원_${rate}x.zip`;
                const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = zipName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
                console.error('ZIP 생성 실패:', err);
                alert('문장별 음원 ZIP 생성 중 오류: ' + (err.message || err));
            } finally {
                btn.disabled = false;
                if (spinner) spinner.classList.remove('on');
            }
        });
        modal.querySelector('.shadow-close').addEventListener('click', closeModal);
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        modal.querySelector('.shadow-speed').addEventListener('change', e => {
            playbackRate = parseFloat(e.target.value) || 1.0;
            if (activeSource) {
                try { activeSource.playbackRate.value = playbackRate; } catch (_) {}
            }
        });
        document.addEventListener('keydown', function escHandler(e) {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escHandler);
                closeModal();
            }
        });
    }

    // ===== "내 결과물" 보관함 패널 =====
    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function fmtHistoryDate(ts) {
        const d = new Date(ts);
        return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ` +
               `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    async function openHistoryPanel() {
        const existing = document.getElementById('history-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'history-modal';
        modal.className = 'shadow-overlay';
        modal.innerHTML = `
            <div class="shadow-dialog history-dialog" role="dialog" aria-modal="true" aria-label="내 결과물">
                <div class="shadow-header">
                    <h3>📁 내 결과물</h3>
                    <button class="shadow-close" aria-label="닫기">&times;</button>
                </div>
                <p class="shadow-tip">💡 이 기기에 저장된 결과물이에요. 재처리 없이 다시 보거나 PDF·음원을 다시 받을 수 있어요.</p>
                <div class="history-body"><div class="history-empty">불러오는 중...</div></div>
            </div>`;
        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        function close() { document.body.style.overflow = ''; modal.remove(); }
        modal.querySelector('.shadow-close').addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(); }
        });

        await renderHistoryList(modal);
    }

    async function renderHistoryList(modal) {
        const body = modal.querySelector('.history-body');
        let records;
        try { records = await historyGetAll(); }
        catch (e) { body.innerHTML = '<div class="history-empty">보관함을 불러오지 못했습니다.</div>'; return; }
        records.sort((a, b) => b.createdAt - a.createdAt);
        if (!records.length) {
            body.innerHTML = '<div class="history-empty">아직 저장된 결과물이 없어요.<br>최종 결과물을 생성하면 여기에 자동 저장됩니다.</div>';
            return;
        }
        body.innerHTML = '<ul class="history-list">' + records.map(r => {
            const title = [r.name, r.school].filter(Boolean).join(' · ') || '이름 없음';
            const snippet = (r.correctedText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            const hasAudio = !!r.audioBase64;
            return `<li class="history-item">
                <div class="history-item-main">
                    <div class="history-item-title">${escHtml(title)}</div>
                    <div class="history-item-date">${fmtHistoryDate(r.createdAt)}${hasAudio ? ' · 🔊 음원' : ''}</div>
                    <div class="history-item-snippet">${escHtml(snippet)}</div>
                </div>
                <div class="history-item-actions">
                    <button class="button history-open" data-id="${r.id}">열기</button>
                    <button class="button history-del" data-id="${r.id}">삭제</button>
                </div>
            </li>`;
        }).join('') + '</ul>';

        body.querySelectorAll('.history-open').forEach(b => b.addEventListener('click', async () => {
            const rec = await historyGet(parseInt(b.dataset.id, 10));
            if (rec) openHistoryDetail(modal, rec);
        }));
        body.querySelectorAll('.history-del').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('이 결과물을 삭제할까요?')) return;
            await historyDelete(parseInt(b.dataset.id, 10));
            await renderHistoryList(modal);
        }));
    }

    function openHistoryDetail(modal, rec) {
        const body = modal.querySelector('.history-body');
        const hasAudio = !!rec.audioBase64;
        const isAnd = isAndroid();
        const dlSpeedHtml = `
            <div class="dl-speed-wrap">
                <button class="button history-audio-dl">⬇ 전체 음원 다운로드 <span class="spinner history-dl-spin"></span></button>
                <label class="dl-speed-label">다운로드 속도
                    <select class="history-dl-speed dl-speed-select">
                        <option value="0.7">느리게 (0.7x)</option>
                        <option value="0.8">약간 느리게 (0.8x)</option>
                        <option value="0.9" selected>보통 (0.9x)</option>
                        <option value="1.0">원어민 속도 (1.0x)</option>
                    </select>
                </label>
            </div>`;
        body.innerHTML = `
            <button class="button history-back">← 목록으로</button>
            <div class="history-detail">
                <div class="history-detail-meta">${escHtml([rec.name, rec.school].filter(Boolean).join(' · ') || '이름 없음')} · ${fmtHistoryDate(rec.createdAt)}</div>
                <h4>✨ 수정글</h4>
                <div class="history-corrected">${rec.correctedHtml || escHtml(rec.correctedText || '')}</div>
                <div class="history-detail-actions">
                    ${hasAudio ? '<audio class="history-audio" controls></audio>' : ''}
                    ${hasAudio ? '<button class="button history-shadow">🎧 문장별 듣기 (쉐도잉)</button>' : ''}
                    ${hasAudio ? dlSpeedHtml : '<p class="dl-help">이 결과물에는 저장된 음원이 없어요. (생성 당시 \'원어민 음성 듣기\'를 실행하지 않음)</p>'}
                    <button class="button history-print">${isAnd ? 'PDF 다운로드' : '인쇄하기'}</button>
                </div>
                <p class="dl-help">💡 다운로드 파일은 기기의 '다운로드' 폴더(아이폰은 '파일' 앱)에 저장됩니다.</p>
            </div>`;

        body.querySelector('.history-back').addEventListener('click', () => renderHistoryList(modal));

        function loadCacheFromRecord() {
            clearShadowingCache();
            const tps = Array.isArray(rec.timepoints) ? rec.timepoints : [];
            const sents = Array.isArray(rec.sentences) ? rec.sentences : [];
            let url = null;
            if (rec.audioBase64) url = URL.createObjectURL(base64ToBlob(rec.audioBase64, 'audio/mpeg'));
            shadowingCache = {
                audioUrl: url,
                timepoints: tps,
                sentences: sents,
                text: rec.correctedText || '',
                rateCache: rec.audioBase64 ? { '0.9': { audioBase64: rec.audioBase64, timepoints: tps, sentences: sents } } : {},
            };
        }

        if (hasAudio) {
            loadCacheFromRecord();
            const audioEl = body.querySelector('.history-audio');
            if (audioEl && shadowingCache.audioUrl) audioEl.src = shadowingCache.audioUrl;

            body.querySelector('.history-shadow').addEventListener('click', () => {
                loadCacheFromRecord();
                openShadowingModal();
            });

            body.querySelector('.history-audio-dl').addEventListener('click', async e => {
                const btn = e.currentTarget;
                const spin = btn.querySelector('.history-dl-spin');
                const rate = parseFloat(body.querySelector('.history-dl-speed')?.value) || 0.9;
                btn.disabled = true; if (spin) spin.style.display = 'inline-block';
                try {
                    loadCacheFromRecord();
                    const tts = await getTTSForRate(rate);
                    const url = URL.createObjectURL(base64ToBlob(tts.audioBase64, 'audio/mpeg'));
                    const a = document.createElement('a');
                    a.href = url; a.download = `${generatePDFFileName(rec.name || '')}_${rate}x.mp3`;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (err) { alert('음원 다운로드 오류: ' + (err.message || err)); }
                finally { btn.disabled = false; if (spin) spin.style.display = 'none'; }
            });
        }

        body.querySelector('.history-print').addEventListener('click', async () => {
            const options = { orig: !!(rec.originalText && rec.originalText.trim()), corr: true, fbCheck: false };
            const userInfo = { name: rec.name || '', school: rec.school || '', type: 'final' };
            if (isAndroid()) {
                await generateAndDownloadPDF(null, rec.originalText || '', null, rec.correctedHtml || '', options, userInfo);
            } else {
                await generateAndPrintHTML(null, rec.originalText || '', null, rec.correctedHtml || '', options, userInfo);
            }
        });
    }


/**
     * ✅ [복원 및 개선] PC/iOS를 위한 '인쇄' 함수
     */
    async function generateAndPrintHTML(imageFile, origText, feedbackHtml, correctedHtml, options, userInfo) {
        const btn = document.getElementById(`action-${userInfo.type}-btn`);
        if (btn) btn.disabled = true;

        try {
            let imageUrl = null;
            if (imageFile && options.orig) {
                imageUrl = await getRotatedImageForPrint(imageFile);
            }
            
            const safeName = (userInfo.name || '').trim();
            const safeSchool = (userInfo.school || '').trim();
            const userInfoHTML = (safeName || safeSchool) ? `
                <div class="user-info-print">
                    <div class="user-info-left">
                        ${safeName ? `<span class="user-info-item"><span class="user-info-label">이름</span> ${safeName}</span>` : ''}
                        ${safeSchool ? `<span class="user-info-item"><span class="user-info-label">학교</span> ${safeSchool}</span>` : ''}
                    </div>
                    <div class="user-info-date">${formatDateKR()}</div>
                </div>` : '';
            let printContent = `<h2>${userInfo.type === 'feedback' ? '피드백 결과' : '최종 결과'}</h2>`;

            if (options.orig) {
                printContent += '<h3>📝 원본</h3><div class="original-content">';
                if (imageUrl) {
                    printContent += `<img src="${imageUrl}" alt="원본 이미지"/>`;
                } else {
                    printContent += `<div style="white-space: pre-wrap;">${origText || '내용 없음'}</div>`;
                }
                printContent += '</div>';
            }
            if (options.fbCheck && feedbackHtml) {
                printContent += '<h3>🎯 피드백</h3><div class="feedback-container-print">' + feedbackHtml + '</div>';
            }
            if (options.corr && correctedHtml) {
                printContent += `<h3>✨ 수정글</h3><div class="corrected-section-print"><div class="corrected-content-print">${correctedHtml.replace(/\n/g, '<br>')}</div></div>`;
            }

            const printHtml = `
                <!doctype html>
                <html lang="ko">
                <head>
                    <meta charset="utf-8"/>
                    <title>${generatePDFFileName(userInfo.name)}</title>
                    <style>
                        @page{margin:15mm;size:A4}
                        body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;color:#1f2937;line-height:1.6;font-size:11pt;}
                        /* === 브랜드 헤더 === */
                        .print-header {
                            display: flex;
                            align-items: center;
                            gap: 14pt;
                            padding-bottom: 10pt;
                            border-bottom: 3pt solid #1e3a8a;
                            margin-bottom: 14pt;
                        }
                        .print-header .logo {
                            width: 100pt;
                            height: auto;
                            flex-shrink: 0;
                        }
                        .print-header .title-block {
                            flex: 1;
                        }
                        .print-header .brand-title {
                            font-size: 22pt;
                            font-weight: 700;
                            color: #1e3a8a;
                            margin: 0 0 2pt 0;
                            letter-spacing: -0.5pt;
                        }
                        .print-header .brand-sub {
                            font-size: 10.5pt;
                            color: #64748b;
                            margin: 0;
                            font-weight: 500;
                        }
                        /* === 사용자 정보 줄 === */
                        .user-info-print {
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            background: #f8fafc;
                            border-left: 3pt solid #1e3a8a;
                            padding: 8pt 12pt;
                            margin-bottom: 18pt;
                            border-radius: 0 4pt 4pt 0;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .user-info-left { display: flex; gap: 18pt; flex-wrap: wrap; }
                        .user-info-item { font-size: 11pt; color: #1e293b; }
                        .user-info-label {
                            display: inline-block;
                            background: #1e3a8a;
                            color: #fff;
                            padding: 1pt 6pt;
                            border-radius: 3pt;
                            font-size: 9pt;
                            font-weight: 700;
                            margin-right: 4pt;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .user-info-date { font-size: 10pt; color: #64748b; }
                        h2{font-size:16pt; color: #1e3a8a; margin-top: 12pt;} h3{font-size:13pt;border-left:3pt solid #7c3aed;padding-left:8pt;margin-top:18pt; page-break-after: avoid;}
                        .original-content img{max-width:70%;}
                        /* 분할 금지는 개별 카드에만 — 카테고리는 페이지 간 자연스럽게 분할 */
                        .fb-item { page-break-inside: avoid; }
                        .feedback-category { page-break-inside: auto; margin-bottom: 8pt; }
                        .feedback-category h3 { margin-top: 12pt; }
                        /* 피드백 카드 인쇄 스타일 */
                        .feedback-container { display: block; }
                        .fb-section-body { display: block; margin-top: 4pt; }
                        .fb-item {
                            background: #fff;
                            border: 1px solid #e2e8f0;
                            border-left: 3pt solid #ef4444;
                            border-radius: 4px;
                            padding: 8pt;
                            margin-bottom: 8pt;
                            display: block;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .feedback-category.vocabulary .fb-item { border-left-color: #f59e0b; }
                        .feedback-category.expression .fb-item { border-left-color: #8b5cf6; }
                        .fb-num {
                            display: inline-block;
                            min-width: 18pt;
                            height: 18pt;
                            line-height: 18pt;
                            text-align: center;
                            background: #ef4444;
                            color: #fff;
                            border-radius: 9pt;
                            font-weight: 700;
                            font-size: 10pt;
                            padding: 0 5pt;
                            margin-right: 6pt;
                            margin-bottom: 4pt;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .feedback-category.vocabulary .fb-num { background: #f59e0b; }
                        .feedback-category.expression .fb-num { background: #8b5cf6; }
                        .fb-rows { display: block; }
                        .fb-row { display: block; margin: 3pt 0; line-height: 1.5; }
                        .fb-tag {
                            display: inline-block;
                            padding: 1pt 5pt;
                            border-radius: 3pt;
                            font-size: 9pt;
                            font-weight: 700;
                            margin-right: 4pt;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .fb-tag-error { background: #fee2e2; color: #991b1b; }
                        .fb-tag-info { background: #dbeafe; color: #1e40af; }
                        .fb-tag-correct { background: #dcfce7; color: #166534; }
                        .fb-content { display: inline; }
                        .fb-quote {
                            background: #f1f5f9;
                            padding: 0 3pt;
                            border-radius: 2pt;
                            font-family: 'Consolas', 'Courier New', monospace;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                    </style>
                </head>
                <body>
                    <div class="print-header">
                        ${window.LOGO_DATA_URI ? `<img class="logo" src="${window.LOGO_DATA_URI}" alt="윤선생"/>` : ''}
                        <div class="title-block">
                            <h1 class="brand-title">윤선생 WriteBack</h1>
                            <p class="brand-sub">영작문 피드백 리포트</p>
                        </div>
                    </div>
                    ${userInfoHTML}
                    ${printContent}

                </body>
                </html>`;
            
            const printWindow = window.open('', '_blank');
            if (!printWindow) {
                alert('팝업이 차단되었습니다. 브라우저 설정을 허용해주세요.');
                if (btn) btn.disabled = false;
                return;
            }
            printWindow.document.write(printHtml);
            printWindow.document.close();
            setTimeout(() => { printWindow.print(); printWindow.close(); }, 500);

        } catch (error) {
            alert("인쇄 중 오류가 발생했습니다: " + error.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }



// PDF 생성 및 다운로드 함수 수정
async function generateAndDownloadPDF(imageFile, origText, feedbackHtml, correctedHtml, options, userInfo) {
    // ✅ PDF 다운로드 버튼과 스피너 찾기
    const downloadBtn = document.getElementById(`download-${userInfo.type}-btn`);
    const spinner = downloadBtn ? downloadBtn.querySelector('.download-spinner') : null;
    const originalBtnText = downloadBtn ? downloadBtn.innerHTML : '';
    
     const scrollY = window.scrollY;

    // 버튼 비활성화 및 스피너 표시
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.style.opacity = '0.7';
        downloadBtn.style.cursor = 'not-allowed';
    }
    if (spinner) {
        spinner.style.display = 'inline-block';
    }

    try {
        let imageUrl = null;
        if (imageFile && options.orig) {
            imageUrl = await getOriginalImageForPrint(imageFile);
        }
        
        const safeName2 = (userInfo.name || '').trim();
        const safeSchool2 = (userInfo.school || '').trim();
        const userInfoHTML = (safeName2 || safeSchool2) ?
            `<div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border-left: 4px solid #1e3a8a; padding: 12px 16px; margin: 0 0 24px 0; border-radius: 0 6px 6px 0;">
                <div style="display: flex; gap: 22px; flex-wrap: wrap;">
                    ${safeName2 ? `<span style="font-size: 14pt; color: #1e293b;"><span style="display: inline-block; background: #1e3a8a; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11pt; font-weight: 700; margin-right: 6px;">이름</span> ${safeName2}</span>` : ''}
                    ${safeSchool2 ? `<span style="font-size: 14pt; color: #1e293b;"><span style="display: inline-block; background: #1e3a8a; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11pt; font-weight: 700; margin-right: 6px;">학교</span> ${safeSchool2}</span>` : ''}
                </div>
                <div style="font-size: 12pt; color: #64748b;">${formatDateKR()}</div>
            </div>` : '';

        // 브랜드 헤더 (로고 + 타이틀 + 서브타이틀)
        const mainTitle = `
            <div style="display: flex; align-items: center; gap: 18px; padding: 0 0 14px 0; border-bottom: 4px solid #1e3a8a; margin: 0 0 20px 0;">
                ${window.LOGO_DATA_URI ? `<img src="${window.LOGO_DATA_URI}" alt="윤선생" style="width: 140px; height: auto; flex-shrink: 0;"/>` : ''}
                <div style="flex: 1;">
                    <div style="font-size: 28pt; font-weight: 700; color: #1e3a8a; line-height: 1.1; margin-bottom: 4px; letter-spacing: -0.5pt;">윤선생 WriteBack</div>
                    <div style="font-size: 13pt; color: #64748b; font-weight: 500;">영작문 피드백 리포트</div>
                </div>
            </div>`;
        
        let printContent = '';

        // 원본 섹션 처리
        if (options.orig) {
            printContent += `<div class="section-break original-section">`;
            printContent += `<h3 style="color: #059669; border-bottom: 2px solid #059669; padding-bottom: 8px; margin-bottom: 20px; font-size: 16pt;">📝 원본</h3>`;
            
            if (imageUrl) {
                printContent += `
                    <div style="text-align: center; margin: 25px 0; padding: 15px; background-color: #fafafa; border-radius: 8px;">
                        <img src="${imageUrl}" alt="원본 이미지" style="max-width: 100%; height: auto; border: 2px solid #ddd; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);"/>
                    </div>`;
            } else if (origText && origText.trim()) {
                printContent += `
                    <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #059669; line-height: 1.8; font-size: 13pt; white-space: pre-wrap; font-family: 'Courier New', monospace; color: #2c3e50; word-wrap: break-word;">${origText.trim()}</div>`;
            }
            printContent += `</div>`;
        }

        // 피드백 섹션 (개선된 텍스트 추출)
        if (options.fbCheck && feedbackHtml) {
            printContent += `<div class="section-break feedback-section">`;
            printContent += `<h3 style="color: #dc2626; border-bottom: 2px solid #dc2626; padding-bottom: 8px; margin-bottom: 20px; font-size: 16pt;">🎯 피드백</h3>`;
            
            const feedbackText = extractAndFormatFeedbackTextImproved(feedbackHtml);
            printContent += `
                <div style="background-color: #fef2f2; padding: 20px; border-radius: 8px; border-left: 4px solid #dc2626;">
                    ${feedbackText}
                </div>`;
            printContent += `</div>`;
        }

        // 수정글 섹션 (원본 포맷 유지)
        if (options.corr && correctedHtml) {
            printContent += `<div class="section-break corrected-section">`;
            printContent += `<h3 style="color: #7c3aed; border-bottom: 2px solid #7c3aed; padding-bottom: 8px; margin-bottom: 20px; font-size: 16pt;">✨ 수정글</h3>`;
            
            // 원본 HTML 구조 유지하면서 포맷팅
            const correctedText = preserveOriginalFormatting(correctedHtml);
            printContent += `
                <div style="background-color: #f0fdf4; padding: 25px; border-radius: 8px; border-left: 4px solid #10b981; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                    ${correctedText}
                </div>`;
            printContent += `</div>`;
        }

        const printHtml = `
            <!DOCTYPE html>
            <html lang="ko">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: '맑은 고딕', 'Malgun Gothic', Arial, sans-serif;
                        color: #333;
                        line-height: 1.7;
                        font-size: 16pt;
                        max-width: 800px;
                        margin: 0 auto;
                        padding: 30px 25px;
                        background-color: white;
                        word-wrap: break-word;
                        overflow-wrap: break-word;

                                       }
                    
                    /* 섹션별 페이지 나누기 */
                    .section-break {
                        page-break-inside: avoid;
                        margin-bottom: 40px;
                        min-height: 200px; /* 최소 높이로 페이지 끝에서 잘림 방지 */
                    }
                    
                    .original-section {
                        page-break-after: auto;
                    }
                    
                    .feedback-section {
                        page-break-before: auto;
                        page-break-after: auto;
                    }
                    
                    .corrected-section {
                        page-break-before: auto;
                    }
                    
                    h1 {
                        page-break-after: avoid;
                        page-break-inside: avoid;
                    }
                    
                    h3 {
                        font-size: 16pt;
                        font-weight: 600;
                        margin-bottom: 20px;
                        margin-top: 30px;
                        page-break-after: avoid;
                        page-break-inside: avoid;
                    }
                    
                    /* 피드백 카테고리별 스타일 */
                    .feedback-category {
                        page-break-inside: avoid;
                        margin-bottom: 25px;
                        padding: 18px;
                        border-radius: 8px;
                        background-color: #f8f9fa;
                        border-left: 4px solid #6366f1;
                        min-height: 80px;
                    }
                    
                    .feedback-title {
                        font-weight: 600;
                        color: #374151;
                        font-size: 20pt;
                        margin-bottom: 12px;
                        display: block;
                        page-break-after: avoid;
                    }
                    
                    .feedback-content {
                        font-size: 18pt;
                        line-height: 1.8;
                        color: #4b5563;
                        margin-bottom: 8px;
                        white-space: pre-wrap;
                        word-wrap: break-word;
                    }
                    
                    /* 수정글 포맷팅 개선 */
                    .corrected-text {
                        line-height: 2.2;
                        font-size: 18pt;
                        font-weight: 500;
                        color: #1f2937;
                        white-space: pre-wrap;
                        word-spacing: 2px;
                        letter-spacing: 0.5px;
                    }
                    
                    .corrected-text p {
                        margin-bottom: 15px;
                        line-height: 2.2;
                    }
                    
                    .corrected-text br + br {
                        line-height: 1.5;
                    }
                    
                    .print-footer {
                        margin-top: 60px;
                        text-align: center;
                        color: #6b7280;
                        font-size: 10pt;
                        border-top: 1px solid #e5e7eb;
                        padding-top: 20px;
                        page-break-inside: avoid;
                    }
                    
                    img {
                        page-break-inside: avoid;
                        page-break-after: avoid;
                    }
                    
                    /* 텍스트 박스 스타일 */
                    .error-highlight {
                        background-color: #fee2e2;
                        padding: 8px 12px;
                        border-radius: 6px;
                        border-left: 3px solid #ef4444;
                        margin: 8px 0;
                        font-size: 18pt;
                        line-height: 1.6;
                    }
                    
                    .correct-highlight {
                        background-color: #dcfce7;
                        padding: 8px 12px;
                        border-radius: 6px;
                        border-left: 3px solid #22c55e;
                        margin: 8px 0;
                        font-size: 18pt;
                        line-height: 1.6;
                    }
                    
                    .explain-highlight {
                        background-color: #dbeafe;
                        padding: 8px 12px;
                        border-radius: 6px;
                        border-left: 3px solid #3b82f6;
                        margin: 8px 0;
                        font-size: 18pt;
                        line-height: 1.6;
                    }
                    
                    @media print {
                        .section-break { 
                            page-break-inside: avoid; 
                            orphans: 3;
                            widows: 3;
                        }
                        body { orphans: 3; widows: 3; }
                    }
                </style>
            </head>
            <body>
                ${mainTitle}
                ${userInfoHTML}
                ${printContent}
                <div class="print-footer">
                    훌륭해요!👍 매일 조금씩 발전하고 있어요. 계속 도전하세요!🙏<br>
                    <strong>윤선생 WriteBack</strong><br>
                    생성일시: ${new Date().toLocaleString('ko-KR')}
                </div>
            </body>
            </html>`;
        
        // 임시 렌더링 영역 생성
        const printArea = document.createElement('div');
        printArea.style.position = 'absolute';
        printArea.style.left = '-9999px';
        printArea.style.top = '0';
        printArea.style.width = '900px';
        printArea.style.backgroundColor = 'white';
        printArea.style.minHeight = '1200px';
        printArea.innerHTML = printHtml;
        document.body.appendChild(printArea);

        // 렌더링 대기 시간 증가
        await new Promise(resolve => setTimeout(resolve, 3000));

        // html2canvas로 렌더링
        const canvas = await html2canvas(printArea, { 
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            width: printArea.scrollWidth,
            height: printArea.scrollHeight,
            scrollX: 0,
            scrollY: 0,
            removeContainer: true
        });
        
        // PDF 생성 (섹션 기반 페이지 분할)
        await createPDFWithSectionBreaks(canvas, userInfo.name);
        
        document.body.removeChild(printArea);
        console.log('PDF 생성 완료');

    } catch (error) {
        console.error("PDF 생성 오류:", error);
        alert("PDF 생성 중 오류가 발생했습니다: " + error.message);
    } finally {
        // ✅ 버튼 상태 복원
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.style.opacity = '1';
            downloadBtn.style.cursor = 'pointer';
        }
        if (spinner) {
            spinner.style.display = 'none';
             window.scrollTo(0, scrollY);
        }
    }
}



// 섹션 기반 PDF 생성 함수 (페이지 나누기 개선)
async function createPDFWithSectionBreaks(canvas, fileName) {
    const doc = new jsPDF('p', 'mm', 'a4');
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 12;
    const contentWidth = pageWidth - (margin * 2);
    const contentHeight = pageHeight - (margin * 2);
    
    const imgWidth = contentWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    
    // 페이지 높이를 더 보수적으로 계산 (여유 공간 확보)
    const usablePageHeight = contentHeight * 0.9; // 10% 여유 공간
    
    let currentY = 0;
    let pageCount = 0;
    
    while (currentY < imgHeight && pageCount < 20) {
        if (pageCount > 0) {
            doc.addPage();
        }
        
        const remainingHeight = imgHeight - currentY;
        let currentPageHeight = Math.min(usablePageHeight, remainingHeight);
        
        // 페이지 경계 근처에서는 더 보수적으로 자르기
        if (remainingHeight > usablePageHeight && remainingHeight < usablePageHeight * 1.3) {
            currentPageHeight = usablePageHeight * 0.7; // 30% 여유 두고 다음 페이지로
        }
        
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        const sourceY = (currentY * canvas.width) / imgWidth;
        const sourceHeight = (currentPageHeight * canvas.width) / imgWidth;
        
        tempCanvas.width = canvas.width;
        tempCanvas.height = sourceHeight;
        
        tempCtx.drawImage(
            canvas,
            0, sourceY, canvas.width, sourceHeight,
            0, 0, canvas.width, sourceHeight
        );
        
        const pageImgData = tempCanvas.toDataURL('image/jpeg', 0.85);
        
        doc.addImage(
            pageImgData, 
            'JPEG', 
            margin, 
            margin, 
            imgWidth, 
            currentPageHeight
        );
        
        currentY += currentPageHeight;
        pageCount++;
    }
    
    doc.save(`${generatePDFFileName(fileName)}.pdf`);
}

// 개선된 피드백 텍스트 추출 함수
function extractAndFormatFeedbackTextImproved(feedbackHtml) {
    if (!feedbackHtml) return '';
    
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = feedbackHtml;
    
    const categories = tempDiv.querySelectorAll('.feedback-category-elementary, .feedback-category');
    let formattedText = '';
    
    if (categories.length > 0) {
        categories.forEach((category, index) => {
            const title = category.querySelector('h3, h4');
            const content = category.querySelector('div:last-child, .feedback-content');
            
            if (title && content) {
                let titleText = title.textContent || title.innerText || '';
                let contentText = content.innerHTML || content.textContent || '';
                
                // 이모티콘 및 특수 문자 유지
                contentText = contentText
                    .replace(/❌\s*원문:/g, '<div class="error-highlight"><strong>❌ 원문:</strong>')
                    .replace(/✅\s*수정:/g, '</div><div class="correct-highlight"><strong>✅ 수정:</strong>')
                    .replace(/💡\s*설명:/g, '</div><div class="explain-highlight"><strong>💡 설명:</strong>')
                    .replace(/<\/div>$/g, '</div></div>'); // 마지막 div 닫기
                
                formattedText += `
                    <div class="feedback-category">
                        <div class="feedback-title">${titleText}</div>
                        <div class="feedback-content">${contentText}</div>
                    </div>`;
            }
        });
    } else {
        const allText = tempDiv.innerHTML || tempDiv.textContent || '';
        formattedText = `<div class="feedback-content">${allText}</div>`;
    }
    
    return formattedText;
}

// 수정글 원본 포맷팅 유지 함수
function preserveOriginalFormatting(correctedHtml) {
    if (!correctedHtml) return '';
    
    // HTML 태그는 유지하되 스타일 최적화
    let formattedText = correctedHtml
        .replace(/<br\s*\/?>/gi, '<br>') // br 태그 정규화
        .replace(/\n/g, '<br>') // 개행을 br 태그로 변환
        .replace(/<br><br>/g, '</p><p>') // 연속된 br을 p 태그로
        .replace(/^/, '<p>') // 시작에 p 태그 추가
        .replace(/$/, '</p>'); // 끝에 p 태그 추가
    
    // p 태그가 중복되지 않도록 정리
    formattedText = formattedText
        .replace(/<p><p>/g, '<p>')
        .replace(/<\/p><\/p>/g, '</p>')
        .replace(/<p>\s*<\/p>/g, ''); // 빈 p 태그 제거
    
    return `<div class="corrected-text">${formattedText}</div>`;
}

// 원본 이미지 처리 함수 (회전 없이 원본 그대로)
function getOriginalImageForPrint(file) {
    return new Promise((resolve) => {
        if (!file) {
            resolve(null);
            return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    
                    // ✅ 이미지만 70% 크기로 조정
                    const scaleFactor = 0.7;
                    canvas.width = Math.round(img.width * scaleFactor);
                    canvas.height = Math.round(img.height * scaleFactor);
                   
                    
                 // 이미지를 조정된 크기로 그리기
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    
                    resolve(canvas.toDataURL('image/jpeg', 0.8));
                    
                } catch (error) {
                    console.error('이미지 처리 오류:', error);
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = e.target.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

// 피드백 텍스트 추출 및 포맷팅 함수 (누락 방지)
function extractAndFormatFeedbackText(feedbackHtml) {
    if (!feedbackHtml) return '';
    
    // 임시 div에 HTML 삽입하여 텍스트 추출
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = feedbackHtml;
    
    // 각 피드백 카테고리별로 처리
    const categories = tempDiv.querySelectorAll('.feedback-category-elementary, .feedback-category');
    let formattedText = '';
    
    if (categories.length > 0) {
        categories.forEach((category, index) => {
            const title = category.querySelector('h3, h4');
            const content = category.querySelector('div:last-child');
            
            if (title && content) {
                const titleText = title.textContent || title.innerText || '';
                const contentText = content.textContent || content.innerText || '';
                
                formattedText += `
                    <div class="feedback-section">
                        <div class="feedback-title">${titleText}</div>
                        <div class="feedback-content">${contentText.replace(/\n/g, '<br>')}</div>
                    </div>`;
            }
        });
    } else {
        // 카테고리가 없는 경우 전체 텍스트 사용
        const allText = tempDiv.textContent || tempDiv.innerText || '';
        formattedText = `<div class="feedback-content" style="line-height: 1.8; font-size: 12pt;">${allText.replace(/\n/g, '<br>')}</div>`;
    }
    
    return formattedText;
}


// PDF 다운로드 버튼 이벤트 리스너 함수 (수정됨)
function addDownloadListener(type, originalText) {
    const downloadBtn = document.getElementById(`download-${type}-btn`);
    if (!downloadBtn) {
        console.error(`Download button not found: download-${type}-btn`);
        return;
    }

    // 기존 이벤트 리스너 제거
    const newDownloadBtn = downloadBtn.cloneNode(true);
    downloadBtn.parentNode.replaceChild(newDownloadBtn, downloadBtn);

    newDownloadBtn.addEventListener('click', async () => {
        console.log(`PDF 다운로드 시작: ${type}`);
        
        const userInfo = {
            name: document.getElementById(`user-name-${type}`)?.value || '',
            school: document.getElementById(`user-school-${type}`)?.value || '',
            type: type
        };
        
        const imageFile = window[`${type}FileObject`];
        
        // 체크박스 상태 확인
        const origCheckbox = document.getElementById(`print_orig_${type === 'feedback' ? 'fb' : 'fn'}`);
        const corrCheckbox = document.getElementById(`print_corr_${type === 'feedback' ? 'fb' : 'fn'}`);
        const fbCheckbox = document.getElementById('print_fb_fb');
        
        const options = {
            orig: origCheckbox ? origCheckbox.checked : false,
            corr: corrCheckbox ? corrCheckbox.checked : false,
            fbCheck: (type === 'feedback' && fbCheckbox) ? fbCheckbox.checked : false
        };
        
        // 콘텐츠 가져오기
        const feedbackElement = document.getElementById('fb-content');
        const correctedElement = document.getElementById(type === 'feedback' ? 'fb-corrected' : 'fn-corrected');
        
        const feedbackHtml = feedbackElement ? feedbackElement.innerHTML : null;
        const correctedHtml = correctedElement ? correctedElement.innerHTML : null;
        
        // 원본 텍스트 확인 (이미지가 없는 경우 텍스트 사용)
        const finalOriginalText = originalText || '';
        
        console.log('Content check:', {
            hasOriginalText: !!finalOriginalText,
            hasImageFile: !!imageFile,
            feedbackHtml: !!feedbackHtml,
            correctedHtml: !!correctedHtml,
            options: options
        });

        // 아무 옵션도 선택되지 않은 경우 경고
        if (!options.orig && !options.corr && !options.fbCheck) {
            alert('출력할 항목을 하나 이상 선택해주세요.');
            return;
        }

        await generateAndDownloadPDF(imageFile, finalOriginalText, feedbackHtml, correctedHtml, options, userInfo);
    });
}

    // --- 이벤트 리스너 설정 ---

    // 탭 전환
    const feedbackTab = document.getElementById('tab-feedback');
    const finalTab = document.getElementById('tab-final');
    const feedbackSection = document.getElementById('feedback-section');
    const finalSection = document.getElementById('final-section');

    if (feedbackTab && finalTab && feedbackSection && finalSection) {
        feedbackTab.addEventListener('click', () => {
            feedbackSection.classList.add('active');
            finalSection.classList.remove('active', 'final-theme');
            feedbackTab.classList.add('active');
            finalTab.classList.remove('active', 'final-theme');
        });
        
        finalTab.addEventListener('click', () => {
            finalSection.classList.add('active', 'final-theme');
            feedbackSection.classList.remove('active');
            finalTab.classList.add('active', 'final-theme');
            feedbackTab.classList.remove('active');
        });
    }

    // "내 결과물" 보관함 버튼
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) {
        historyBtn.addEventListener('click', () => { openHistoryPanel().catch(() => {}); });
    }

    // 리셋 버튼
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('현재 화면의 입력 내용을 초기화합니다.\n(저장된 결과물은 우측 상단 \'내 결과물\'에 그대로 남아 있어요.)\n계속할까요?')) {
                window.location.reload();
            }
        });
    }

    // 파일 업로드 및 OCR 실행
    ['feedback', 'final'].forEach(section => {
        ['camera', 'gallery'].forEach(src => {
            const fileInput = document.getElementById(`contentFile-${src}-${section}`);
            if (fileInput) {
                fileInput.addEventListener('change', async e => {
                    const file = e.target.files[0];
                    if (!file) return;
                    
                    // File 객체를 window에 저장
                    window[`${section}FileObject`] = file;
                    
                    const fileInfo = document.getElementById(`file-info-${section}`);
                    const fileName = fileInfo?.querySelector('.file-name');
                    if (fileInfo && fileName) {
                        fileName.textContent = file.name;
                        fileInfo.classList.add('show');
                    }
                    
                    await doOCR(file, section);
                });
            }
        });
    });



 // ✅ '피드백 받기' 폼 제출 리스너 (최종본)
document.getElementById('feedback-form').addEventListener('submit', async e => {
    e.preventDefault();
    const contentText = document.getElementById('contentText-feedback').value.trim();
    if (!contentText) {
        alert("내용을 입력하거나 이미지 업로드 후 실행해주세요!");
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    const spinner = btn.querySelector('.spinner');
    btn.disabled = true;
    spinner.style.display = 'inline-block';

    try {
        const res = await fetch(`${API_BASE_URL}/feedbackFunction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contentText })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ error: '알 수 없는 서버 오류' }));
            throw new Error(errorData.error || '서버 응답 오류');
        }

        const data = await res.json();
        const container = document.getElementById('feedback-result');

        // 기기에 따라 버튼 텍스트와 ID를 동적으로 결정
        const actionButtonText = isAndroid() ? 'PDF 다운로드' : '인쇄하기';
        const actionButtonId = `action-feedback-btn`;

        container.innerHTML = `
            <p style="text-align: left;">📢 AI는 실수를 할 수 있습니다. 꼭 생성된 내용을 확인 후 필요한 부분은 수정하셔서 이용해주세요~!</p>
            <div class="box" id="fb-box">
                <h2>피드백</h2>
                <div class="edit-instruction">내용에서 원하는 부분을 수정하려면 Edit 버튼을 누른 후 입력하시고 Save를 눌러 저장해주세요.</div>
                <div id="fb-content">${processFeedback(data.feedback)}</div>
            </div>
            <div class="corrected-section" id="fb-corr-box">
                <h3><i class="fas fa-check-circle"></i> 수정글</h3>
                <div class="edit-instruction">내용에서 원하는 부분을 수정하려면 Edit 버튼을 누른 후 입력하시고 Save를 눌러 저장해주세요.</div>
                <div class="corrected-content" id="fb-corrected">${data.modelAnswer ? renderMarkdownContent(data.modelAnswer) : '피드백 할 내용이 없습니다.'}</div>
            </div>
            <div class="print-options-inline">
                <label><input type="checkbox" id="print_orig_fb" checked> 원본</label>
                <label><input type="checkbox" id="print_fb_fb" checked> 피드백</label>
                <label><input type="checkbox" id="print_corr_fb" checked> 수정글</label>
                <button id="${actionButtonId}" class="button">${actionButtonText}</button>

                <p class="print-info-text">'인쇄하기'를 누르면 프린터로 인쇄하거나 PDF파일로 저장하여 공유할 수 있습니다.</p>
            </div>`;
        
        // 결과가 생성된 후, 필요한 이벤트 리스너들을 연결
        addActionListener('feedback', contentText);
        addEditSaveLogic('fb-box', 'fb-content');
        addEditSaveLogic('fb-corr-box', 'fb-corrected');

    } catch (err) {
        alert('피드백 요청 중 오류: ' + err.message);
    } finally {
        btn.disabled = false;
        spinner.style.display = 'none';
    }
});
    

 // ✅ '최종 결과물 생성' 폼 제출 리스너 (최종본)
document.getElementById('final-form').addEventListener('submit', async e => {
    e.preventDefault();
    const contentText = document.getElementById('contentText-final').value.trim();
    if (!contentText) {
        alert("내용을 입력하거나 이미지 업로드 후 실행해주세요!");
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    const spinner = btn.querySelector('.spinner');
    btn.disabled = true;
    spinner.style.display = 'inline-block';

    try {
        const res = await fetch(`${API_BASE_URL}/feedbackFunction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contentText })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ error: '알 수 없는 서버 오류' }));
            throw new Error(errorData.error || '서버 응답 오류');
        }

        const data = await res.json();
        const container = document.getElementById('final-result');

        // 기기에 따라 버튼 텍스트와 ID를 동적으로 결정
        const actionButtonText = isAndroid() ? 'PDF 다운로드' : '인쇄하기';
        const actionButtonId = `action-final-btn`;

        container.innerHTML = `
            <p style="text-align: left;">📢 AI는 실수를 할 수 있습니다. 꼭 생성된 내용을 확인 후 필요한 부분은 수정하셔서 이용해주세요~!</p>
            <div class="corrected-section" id="fn-box">
                <h3><i class="fas fa-check-circle"></i> 수정글</h3>
                <div class="edit-instruction">내용에서 원하는 부분을 수정하려면 Edit 버튼을 누른 후 입력하시고 Save를 눌러 저장해주세요.</div>
                <div class="corrected-content" id="fn-corrected"
                     style="background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 8px; padding: 24px 18px; margin-top: 10px; box-shadow: 0 2px 8px rgba(16,185,129,0.07);">
                    ${data.modelAnswer ? renderMarkdownContent(data.modelAnswer) : '피드백 할 내용이 없습니다.'}
                </div>
            </div>
            <div class="audio-controls-area">
                <button id="tts-play-btn" class="button">🔊 원어민 음성 듣기 <span id="tts-spinner" class="spinner"></span></button>
                <audio id="tts-audio-final" controls style="display:none;"></audio>
                <button id="shadowing-open-btn" class="button" style="display:none;">🎧 문장별 듣기 (쉐도잉)</button>
                <div id="tts-download-wrap" class="dl-speed-wrap" style="display:none;">
                    <button id="tts-download-btn" class="button">⬇ 전체 음원 다운로드 <span id="tts-dl-spinner" class="spinner"></span></button>
                    <label class="dl-speed-label">다운로드 속도
                        <select id="tts-dl-speed" class="dl-speed-select">
                            <option value="0.7">느리게 (0.7x)</option>
                            <option value="0.8">약간 느리게 (0.8x)</option>
                            <option value="0.9" selected>보통 (0.9x)</option>
                            <option value="1.0">원어민 속도 (1.0x)</option>
                        </select>
                    </label>
                </div>
                <p class="dl-help">💡 다운로드한 파일은 기기의 '다운로드' 폴더(아이폰은 '파일' 앱)에 저장됩니다. 지난 결과물은 우측 상단 '내 결과물'에서 다시 받을 수 있어요.</p>
            </div>
            <div class="print-options-inline">
                <label><input type="checkbox" id="print_orig_fn" checked> 원본</label>
                <label><input type="checkbox" id="print_corr_fn" checked> 수정글</label>
                <button id="${actionButtonId}" class="button">${actionButtonText}</button>
                <p class="print-info-text">'인쇄하기'를 누르면 프린터로 인쇄하거나 PDF파일로 저장하여 공유할 수 있습니다.</p>
            </div>`;

        // 결과가 생성된 후, 필요한 이벤트 리스너들을 연결
        addActionListener('final', contentText);
        addTTSListener();
        addShadowingListener();
        addEditSaveLogic('fn-box', 'fn-corrected');

        // 로컬 보관함에 최종 결과 저장 (성공한 경우만, 음원은 '원어민 음성 듣기' 시 추가 저장)
        currentResultId = null;
        const modelAnswer = (data.modelAnswer || '').trim();
        const FAILURE_ANSWERS = [
            '수정글 생성에 실패했습니다. 피드백 내용을 참고해주세요.',
            '피드백을 제공할 영어 문장이 없습니다. 영작문을 입력해주세요.',
        ];
        const isValidResult = modelAnswer && !FAILURE_ANSWERS.includes(modelAnswer);
        if (isValidResult) {
            try {
                const nameVal = document.getElementById('user-name-final')?.value?.trim() || '';
                const schoolVal = document.getElementById('user-school-final')?.value?.trim() || '';
                const correctedText = document.getElementById('fn-corrected')?.innerText || '';
                currentResultId = await historyAdd({
                    createdAt: Date.now(),
                    name: nameVal,
                    school: schoolVal,
                    originalText: contentText,
                    correctedText,
                    correctedHtml: document.getElementById('fn-corrected')?.innerHTML || '',
                    audioBase64: null,
                    timepoints: [],
                    sentences: [],
                });
            } catch (_) { currentResultId = null; }
        }

        // 수정글이 편집되면 캐시된 음성과 불일치 → 캐시 무효화
        const fnCorrected = document.getElementById('fn-corrected');
        if (fnCorrected) {
            fnCorrected.addEventListener('input', () => {
                if (!shadowingCache.audioUrl) return;
                clearShadowingCache();
                const audio = document.getElementById('tts-audio-final');
                const dlWrap = document.getElementById('tts-download-wrap');
                const shadowingBtn = document.getElementById('shadowing-open-btn');
                if (audio) { audio.pause(); audio.removeAttribute('src'); audio.style.display = 'none'; }
                if (dlWrap) dlWrap.style.display = 'none';
                if (shadowingBtn) shadowingBtn.style.display = 'none';
            });
        }

    } catch (err) {
        alert('최종 결과물 생성 중 오류: ' + err.message);
    } finally {
        btn.disabled = false;
        spinner.style.display = 'none';
    }
});

   /**
     * ✅ [새로운 메인 리스너] 버튼 클릭 시 기기를 확인하고 적절한 함수를 호출
     */
    function addActionListener(type, originalText) {
        const actionBtn = document.getElementById(`action-${type}-btn`);
        if (!actionBtn) return;

        actionBtn.addEventListener('click', async () => {
            const userInfo = { name: document.getElementById(`user-name-${type}`).value, school: document.getElementById(`user-school-${type}`).value, type };
            const imageFile = window[`${type}FileObject`];
            const options = {
                orig: document.getElementById(`print_orig_${type === 'feedback' ? 'fb' : 'fn'}`).checked,
                corr: document.getElementById(`print_corr_${type === 'feedback' ? 'fb' : 'fn'}`).checked,
                fbCheck: (type === 'feedback') ? document.getElementById('print_fb_fb').checked : false
            };
            const feedbackHtml = type === 'feedback' ? document.getElementById('fb-content')?.innerHTML : null;
            const correctedHtml = document.getElementById(type === 'feedback' ? 'fb-corrected' : 'fn-corrected')?.innerHTML;

            if (isAndroid()) {
                // 안드로이드일 경우 PDF 다운로드 함수 호출
                await generateAndDownloadPDF(imageFile, originalText, feedbackHtml, correctedHtml, options, userInfo);
            } else {
                // PC 또는 iOS일 경우 인쇄 함수 호출
                await generateAndPrintHTML(imageFile, originalText, feedbackHtml, correctedHtml, options, userInfo);
            }
        });
    }
});