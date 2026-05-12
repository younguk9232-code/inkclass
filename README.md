# Inkclass v1.0

미니멀하고 감각적인 인터랙티브 에듀테크. 굿노트급 잉크 + 루미오/니어팟/클래스킥의 라이브 수업.

## 기능 요약

- 교사 대시보드 — 수업 자료(PPT/PDF/이미지/Google Slides) 만들기·편집, 라이브 수업, 세션 아카이브, 학생별 기록, QR 접속
- 학생 대시보드 — 라이브 수업 참여, 본인 기록 확인
- 4모드 — PPT(시청만), 전체(루미오 whole-class), 개별(개인 학습지), 그룹(모둠)
- 2흐름 — 교사 흐름 / 학생 흐름(수업 중 토글 가능)
- 진행 상황 갤러리 — 클래스킥 스타일 실시간 썸네일
- 그룹 — 랜덤 배정 + 드래그앤드롭, 실시간 수정/삭제/추가
- 굿노트급 잉크 — Pointer Events + 압력감지 + 베지어 스무딩
- QR — 교사 1인 1QR, 스캔 즉시 진행 중인 수업으로 합류
- 인쇄 — 세션 학생 기록 전체/선택 출력

## 로컬 실행
```bash
python3 -m http.server 5173
# → http://localhost:5173
```
환경변수 미설정 상태에서는 단일 브라우저(BroadcastChannel + localStorage)로 작동하는 데모 모드입니다.

## 배포 (무료 스택)

**선정**: Supabase(DB/Realtime/Storage) + Vercel(정적 호스팅)
- Supabase 무료: 500MB DB, 1GB Storage, Realtime 200 동접, 50K MAU
- Vercel 무료: 100GB 대역폭/월, 무제한 정적 배포

### 1) Supabase 셋업
1. https://supabase.com → New project (DB password 기록)
2. SQL Editor → `db/schema.sql` 전체 붙여넣기 → Run
3. Storage → New bucket: `slides` (public)
4. Project Settings → API → `Project URL`, `anon public` key 복사

### 2) 클라이언트에 키 주입
`env.js` 편집:
```js
window.INKCLASS_SUPABASE_URL = "https://xxx.supabase.co";
window.INKCLASS_SUPABASE_ANON = "eyJ...";
```
이 값이 채워지면 자동으로 클라우드 모드로 전환, 다중 디바이스 실시간 동기화.

### 3) Vercel 배포
```bash
npx vercel --yes        # 처음이면 로그인 안내 → 이후 자동 배포
# 또는
npx vercel deploy --prod --yes
```
대안: 폴더를 https://app.netlify.com/drop 에 드래그하면 즉시 배포.
또는 Cloudflare Pages: `npx wrangler pages deploy . --project-name inkclass`

## 무료 DB 플랫폼 비교

| 플랫폼 | DB | 실시간 | 저장소 | 적합도 |
|---|---|---|---|---|
| **Supabase** ★ | Postgres 500MB | Broadcast/Presence/CDC | 1GB | ★★★★★ |
| Firebase Spark | Firestore 1GB | 자체 | 1GB | ★★★★ |
| Neon | Postgres 0.5GB | 없음 | — | ★★ |
| PlanetScale | MySQL 5GB | 없음 | — | ★★ |
| Cloudflare D1+DO | SQLite 5GB | Durable Objects | R2 별도 | ★★★★ |

선정 사유: 관계형 세션 모델 + 실시간 필기 + 슬라이드 이미지 저장이 한 플랫폼에서 해결되며 무료 한도가 학교 단위 사용에 충분.

## 디렉터리
```
.
├─ index.html            앱 셸 + 템플릿
├─ env.js                Supabase 키 (편집)
├─ styles.css            디자인
├─ js/
│   ├─ app.js            라우터 + 부트
│   ├─ store.js          반응형 스토어 + localStorage
│   ├─ sync.js           BroadcastChannel 동기화 (로컬 모드)
│   ├─ cloud.js          Supabase 어댑터 (클라우드 모드)
│   ├─ canvas.js         압력감지 잉크 캔버스
│   ├─ lesson-view.js    슬라이드 프레임 (배경/잉크/텍스트)
│   ├─ teacher.js        교사 대시보드
│   ├─ student.js        학생 대시보드
│   ├─ router.js, ui.js  유틸
├─ db/schema.sql         Supabase 스키마
├─ vercel.json           Vercel 설정
└─ package.json
```
