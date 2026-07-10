# PR 설명 자동 작성 CLI를 직접 만들며 만난 버그 10가지

> "PR 올릴 때 작업 내용·테스트 방법이 **제출 전에** 자동으로 채워졌으면 좋겠다"
> 이 작은 바람에서 시작해, 의존성 0개짜리 Node CLI 하나를 만들어 배포하기까지의 기록.

## 왜 만들었나

우리 팀은 이미 [Qodo PR-Agent](https://github.com/qodo-ai/pr-agent) 봇을 쓰고 있었다. PR을 열면 봇이 자동으로 설명을 써준다. 그런데 결정적인 불편함이 있었다.

- 봇은 **PR을 제출한 "뒤"** 에 본문을 채운다.
- 그래서 내용을 고치려면 **다시 Edit 버튼을 눌러야** 한다.

내가 원한 건 "**제출 전 창에 미리 채워지고, 그 자리에서 수정**"이었다. GitHub 구조상 봇은 이걸 못 한다(diff를 읽으려면 PR이 먼저 존재해야 하니까). 그럼 **로컬에서 미리 생성**하는 수밖에 없다. → 직접 만들자.

## 어떻게 동작하나

```
현재 브랜치 diff 수집
  → Gemini에게 한국어 PR 본문(작업 내용/테스트 방법) 요청
  → GitHub "URL로 본문 미리 채우기"(?expand=1&body=...) 로
     내용이 채워진 PR 생성 페이지를 브라우저로 오픈
  → 창에서 수정 후 제출
```

핵심 트릭은 GitHub의 `compare/base...head?expand=1&body=<내용>` URL이다. 이 URL을 열면 PR 생성 창이 그 내용으로 채워진 채 뜬다. 덕분에 `gh` CLI 없이 **git + Node 내장 fetch + 브라우저**만으로 완성된다.

- 형태: `npm i -g github:<user>/<repo>` 로 설치하는 전역 CLI
- 의존성: **0개** (Node 18+ 내장 `fetch`만 사용)
- 키: `.env.local` / `.env` / 전역 `~/.ai-pr.env` 에서 로드

---

## 본론: 실전에서 만난 버그 10가지

만드는 것보다 **돌려보며 터진 버그를 잡는 과정**이 훨씬 길고 재밌었다. 순서대로.

### 1. Node는 `.env`를 자동으로 안 읽는다

`.env.local`에 키를 넣으면 될 줄 알았다. 안 됐다.

- **원인**: Next.js 프로젝트에서 `.env.local`이 자동으로 읽히는 건 **Next가 로드해주기 때문**이다. 독립 실행 CLI에서 Node는 `.env`를 자동으로 읽지 않는다.
- **해결**: 의존성 없이 직접 `.env` 파서를 구현. `cwd`의 `.env.local`→`.env`, 없으면 전역 `~/.ai-pr.env` 순으로 로드.

### 2. PowerShell이 만든 `.env`의 BOM

파서를 만들었는데도 키를 못 읽었다.

- **원인**: Windows PowerShell 5.1의 `Out-File -Encoding utf8`은 파일 맨 앞에 **BOM(`﻿`)** 을 붙인다. 그래서 첫 줄 키 이름이 `﻿GEMINI_API_KEY`가 되어 매칭 실패.
- **해결**: 파일을 읽은 뒤 맨 앞 BOM을 제거.

### 3. 명령어를 `.env` 파일에 통째로 붙여넣음 (사용자 실수)

키 값이 100자에, 끝이 `...ascii`로 끝났다. 파일을 까보니 이런 게 들어 있었다.

```
"GEMINI_API_KEY=<진짜키>" | Out-File "$HOME\.ai-pr.env" -Encoding ascii
```

**터미널에서 실행할 명령**을 VS Code에서 파일 내용으로 붙여넣은 것. 흔한 초보 실수다.

- **해결**: 파일에서 키만 추출해 정리 + 파서를 견고하게 (줄 전체를 감싼 따옴표, 키/값에 잘못 붙은 따옴표까지 방어).

### 4. API 키가 커밋에 딸려 들어감 🔒

`git add .` 한 방에 `.env.local`이 커밋에 포함됐다.

- **원인**: `.gitignore`에 `.env`만 있고 `.env.local`은 없었다. 추적 중인 파일엔 `.gitignore`가 안 먹는다.
- **해결**: 원격이 없어(로컬 전용) 유출 전이었다. `git rm --cached` → `commit --amend`로 히스토리에서 제거 → `reflog expire` + `gc --prune=now`로 dangling blob까지 purge. `.gitignore`는 `.env*`로 강화.
- **교훈**: 새 repo 만들 때 `.gitignore`부터. 그리고 `git add .`는 무섭다.

### 5. Windows에서 libuv assertion 크래시

API 에러가 나면 프로세스가 이런 걸 뱉으며 죽었다.

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
```

- **원인**: `fetch`로 열린 소켓이 살아있는 상태에서 `process.exit()`를 강제 호출하면 Windows libuv가 assert하는 알려진 버그.
- **해결**: `process.exit()`를 없애고, 실패는 커스텀 `CliError`로 던진 뒤 최상단에서 `process.exitCode = 1`만 지정 → 이벤트 루프가 자연 종료.

### 6. 모델이 어느 날 갑자기 폐기됨 (404)

잘 되던 `gemini-2.5-flash`가 404를 냈다.

```
This model models/gemini-2.5-flash is no longer available.
```

- **원인**: Google이 모델을 폐기 전환 중. `ListModels`엔 나오는데 `generateContent`에선 404가 들쭉날쭉.
- **해결**: **모델 폴백 체인**. 한 모델이 안 되면 다음 모델로 자동 전환.

### 7. 무료 티어 할당량(429)과 과부하(503)

폴백을 넣었더니 이번엔 줄줄이 다른 에러.

- `429` = "exceeded your current quota" (무료 할당량 소진)
- `503` = "experiencing high demand" (일시 과부하)
- **핵심 인사이트**: 무료 티어 할당량은 **모델별로 분리**돼 있다. 한 모델이 429여도 다른 모델은 살아있을 수 있다.
- **해결**: 폴백 모델을 6종으로 확대 + 503/429는 잠깐 뒤 재시도. 실제로 `flash-lite` 계열까지 내려가서 결국 성공했다.

### 8. `fetch`가 무한 대기

한 번은 2분 넘게 "생성 중..."에서 멈췄다.

- **원인**: 과부하된 모델이 응답 없이 커넥션을 물고 있는데, `fetch`엔 기본 타임아웃이 없다.
- **해결**: `AbortController`로 요청당 30초 타임아웃. 매달리면 다음 모델로.

### 9. PR 본문이 안 채워짐 — URL의 `&`가 잘림

드디어 생성은 됐는데, 브라우저 PR 창에 **본문이 비어** 있었다.

- **원인**: Windows에서 `cmd /c start "" <url>`로 브라우저를 열었는데, cmd가 URL 속 `&`를 **명령 구분자**로 오해해서 `&body=...` 부분을 잘라먹었다. `?expand=1`까지만 열리고 본문이 증발.
- **해결(1차)**: `explorer.exe`로 열기 → 새 문제 발생(아래).

### 10. `explorer.exe`가 문서 폴더를 열어버림

`&` 문제를 피하려 `explorer.exe`로 바꿨더니, 이번엔 브라우저가 아니라 **"문서(Documents) 폴더"** 가 열렸다.

- **원인**: `explorer.exe`는 인자를 URL로 못 알아들으면 문서 폴더를 여는 고약한 습성이 있다.
- **최종 해결**: PowerShell `Start-Process`로 열기. URL을 작은따옴표로 감싸 `&`·`%`가 그대로 전달되게 함. + 자동 열기가 실패하는 환경 대비로 **PR 링크를 콘솔에도 항상 출력**하는 안전장치 추가.

### 보너스: 한글 깨짐은 사실 "테스트의 버그"였다

마지막에 본문이 `?묒뾽 ?댁슜`처럼 깨져 보였다. 알고 보니 **도구가 아니라 내 검증 명령**이 문제였다. PowerShell `Get-Content`가 UTF-8 파일을 CP949로 읽어 mojibake가 난 것. 실제 도구는 Node라 `encodeURIComponent`가 올바른 UTF-8 퍼센트 인코딩을 만들어 정상이었다.

- **교훈**: 버그를 재현/검증하는 **도구 자체가 인코딩을 오염**시킬 수 있다. 재현 환경과 실제 실행 환경을 헷갈리지 말자.

---

## 마무리하며

| # | 버그 | 한 줄 원인 | 해결 |
|---|---|---|---|
| 1 | `.env` 안 읽힘 | Node는 `.env` 자동 로드 안 함 | 직접 파서 구현 |
| 2 | BOM으로 키 매칭 실패 | PowerShell utf8 = BOM | BOM 제거 |
| 3 | 파일에 명령어를 붙여넣음 | 사용자 실수 | 파서 견고화 |
| 4 | 키가 커밋됨 | `.gitignore` 누락 | 히스토리 purge + `.env*` |
| 5 | libuv 크래시 | 소켓 열린 채 `process.exit()` | `exitCode`로 자연 종료 |
| 6 | 모델 404 | 모델 폐기 | 폴백 체인 |
| 7 | 429/503 | 무료 할당량/과부하 | 재시도 + 모델 확대 |
| 8 | fetch 무한 대기 | 타임아웃 없음 | `AbortController` 30초 |
| 9 | 본문 안 채워짐 | cmd가 `&` 잘라먹음 | `Start-Process` |
| 10 | 문서 폴더 열림 | explorer의 URL 오인식 | `Start-Process` + 링크 출력 |

만들 땐 30분, 디버깅엔 몇 시간. 하지만 **직접 만든 도구가 실제로 내 워크플로를 바꾸는** 경험은 그만한 값어치가 있었다. 이제 아무 브랜치에서 `ai-pr` 한 번이면, 한글로 채워진 PR 창이 뜬다.

가장 크게 배운 것: **"내 환경(Windows/PowerShell)"이 곧 버그의 원천**이라는 것. `.env` 로딩, BOM, cmd의 `&`, explorer, 인코딩 — 절반이 플랫폼 특성에서 왔다. 크로스플랫폼 CLI를 만든다는 건, 결국 이런 구석들을 하나씩 밟아보는 일이었다.
