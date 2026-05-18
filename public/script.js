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
                html += `
                    <div class="feedback-category ${color}">
                        <h3><i class="fas ${icon}"></i> ${title}</h3>
                        <div>${match[1].trim().replace(/\n/g, '<br>')}</div>
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
        });
    }

    // TTS 리스너 추가 함수
    function addTTSListener() {
        const ttsBtn = document.getElementById('tts-play-btn');
        if (!ttsBtn) return;

        // 기존 이벤트 리스너 제거
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
                
                if (!res.ok) throw new Error('음성 파일 생성 실패');
                
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const audio = document.getElementById('tts-audio-final');
                const dl = document.getElementById('tts-download-btn');
                
                if (audio && dl) {
                    audio.src = url;
                    audio.style.display = 'block';
                    dl.style.display = 'inline-block';
                    dl.href = url;
                    dl.download = `${generatePDFFileName(document.getElementById('user-name-final')?.value || '')}.mp3`;
                }

            } catch (err) {
                alert('TTS 오류: ' + err.message);
            } finally {
                playBtn.disabled = false;
                spinner.style.display = 'none';
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
            
            const userInfoHTML = (userInfo.name?.trim() || userInfo.school?.trim()) ? `<div class="user-info-print"><strong>이름:</strong> ${userInfo.name.trim()} &nbsp;&nbsp; <strong>학교:</strong> ${userInfo.school.trim()}</div>` : '';
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
                        body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;color:#333;line-height:1.6;font-size:11pt;}
                        .print-header{text-align:center;padding-bottom:10px;border-bottom:2px solid #4a5568;margin-bottom:20px;}
                        h1{font-size:18pt;color:#1e3a8a;} h2{font-size:16pt;} h3{font-size:13pt;border-left:3px solid #7c3aed;padding-left:8px;margin-top:20px;}
                        div,p{page-break-inside:avoid;} .original-content img{max-width:70%;}
                    </style>
                </head>
                <body>
                    <div class="print-header"><h1>🎉윤선생 WriteBack🎉</h1></div>
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
        
        const userInfoHTML = (userInfo.name?.trim() || userInfo.school?.trim()) ? 
            `<div style="margin-bottom: 25px; padding: 15px; background-color: #f8f9fa; border-radius: 8px; text-align: center; border: 1px solid #dee2e6;">
                <strong style="color: #495057;">이름:</strong> <span style="color: #212529;">${userInfo.name?.trim() || ''}</span> &nbsp;&nbsp; 
                <strong style="color: #495057;">학교(학년):</strong> <span style="color: #212529;">${userInfo.school?.trim() || ''}</span>
            </div>` : '';
        
        // 메인 타이틀
        const mainTitle = `<h1 style="color: #2563eb; margin: 20px 0 30px 0; font-size: 24pt; font-weight: 700; text-align: center; border-bottom: 3px solid #2563eb; padding-bottom: 15px;">🎉윤선생 WriteBack🎉</h1>`;
        
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

    // 리셋 버튼
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('정말로 모든 내용을 초기화하시겠습니까?')) {
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
                <div class="corrected-content" id="fb-corrected">${data.modelAnswer?.replace(/\n/g, '<br>') ?? '피드백 할 내용이 없습니다.'}</div>
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
                    ${data.modelAnswer?.replace(/\n/g, '<br>') ?? '피드백 할 내용이 없습니다.'}
                </div>
            </div>
            <div class="audio-controls-area">
                <button id="tts-play-btn" class="button">원어민 음성 듣기 <span id="tts-spinner" class="spinner"></span></button>
                <audio id="tts-audio-final" controls style="display:none;"></audio>
                <a id="tts-download-btn" style="display:none;">음원 다운로드</a>
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
        addEditSaveLogic('fn-box', 'fn-corrected');

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