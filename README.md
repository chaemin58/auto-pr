# ai-pr

브랜치의 변경사항(diff)을 AI(Gemini)로 요약해 **PR 본문(작업 내용 / 테스트 방법)** 을 만들고,
내용이 **미리 채워진 GitHub PR 생성 페이지**를 브라우저로 열어줍니다.
창에서 바로 수정한 뒤 제출할 수 있어, "봇이 제출 후에 덮어쓰는" 방식의 불편함이 없습니다.

- 의존성 0개 (Node 18+ 내장 `fetch`만 사용)
- Windows / macOS / Linux 모두 동작

## 설치

### 1) 전역 설치 후 어디서든 사용

```bash
npm install -g ai-pr
```

### 2) 설치 없이 실행

```bash
npx ai-pr
```

## 사전 준비 (딱 한 번)

[Google AI Studio](https://aistudio.google.com/apikey)에서 API 키를 발급받아 아래 중 **한 가지** 방법으로 저장하세요.

### 방법 A) `.env` 파일에 넣기 (추천 · 간편)

**전역**으로 한 번만 설정하면 어느 프로젝트에서든 동작합니다. 홈 폴더에 `~/.ai-pr.env` 파일을 만들고:

```
GEMINI_API_KEY=발급받은키
```

특정 프로젝트에서만 쓰려면 그 프로젝트 폴더의 `.env.local` 또는 `.env`에 같은 줄을 넣어도 됩니다.
읽는 우선순위: 현재 폴더 `.env.local` → `.env` → 전역 `~/.ai-pr.env`.

> ⚠️ 키는 비밀번호입니다. `.env*` 파일이 `.gitignore`에 포함돼 있는지 꼭 확인하세요.

### 방법 B) 시스템 환경변수에 넣기

**Windows (PowerShell):**

```powershell
setx GEMINI_API_KEY "발급받은키"
# setx 후에는 새 터미널을 열어야 적용됩니다
```

**macOS / Linux (bash/zsh):**

```bash
echo 'export GEMINI_API_KEY="발급받은키"' >> ~/.zshrc   # 또는 ~/.bashrc
source ~/.zshrc
```

## 사용법

PR을 만들 **기능 브랜치**에서 실행하세요.

```bash
ai-pr                 # base 브랜치 자동 감지 (origin 기본 브랜치)
ai-pr --base main     # base 브랜치 지정
ai-pr --print         # 브라우저 대신 콘솔에 본문만 출력
ai-pr --dry-run       # AI 호출 없이 감지된 정보만 확인
ai-pr --help
```

### 환경변수

| 변수 | 설명 |
|---|---|
| `GEMINI_API_KEY` | (필수) Gemini API 키 |
| `AI_PR_BASE` | base 브랜치 기본값 (`--base`로 덮어씀) |
| `AI_PR_MODEL` | 모델 지정 (미지정 시 여러 모델을 순서대로 자동 폴백, `--model`로 덮어씀) |

## 동작 방식

1. 현재 브랜치와 base 브랜치 사이의 diff / 커밋 목록을 수집
2. Gemini에게 한국어 PR 본문(작업 내용 / 테스트 방법)을 요청
3. GitHub의 "URL로 본문 미리 채우기"(`?expand=1&body=...`) 기능으로
   내용이 채워진 PR 생성 페이지를 브라우저로 엶
4. 본문이 URL 한계를 넘길 만큼 길면, 콘솔에 본문을 출력해 붙여넣을 수 있게 함

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `429 ... exceeded your current quota` | 무료 티어 할당량 초과. 잠시(분/일 단위) 기다렸다 재시도하거나 결제 설정 확인 |
| `503 ... high demand` | 모델 일시 과부하. 도구가 자동 재시도/폴백하며, 계속되면 잠시 후 재시도 |
| `404 ... no longer available` | 해당 모델 폐기. 도구가 자동으로 다음 모델로 폴백 (또는 `--model`로 지정) |
| `401 UNAUTHENTICATED` | 키가 유효한 AI Studio 키가 아님. `AIza`로 시작하는 키인지 확인 |
| `GEMINI_API_KEY 환경변수가 없습니다` | 키 파일/환경변수 미설정. 위 "사전 준비" 참고 |

미지정 시 여러 모델을 순서대로 시도(폴백)하며, 각 요청은 30초 타임아웃이 걸려 매달리지 않습니다.

## 로컬 개발

```bash
git clone <this-repo>
cd ai-pr
npm link          # 전역에 심볼릭 링크 → ai-pr 명령 사용 가능
ai-pr --dry-run   # 다른 git 저장소에서 테스트
```

## License

MIT
