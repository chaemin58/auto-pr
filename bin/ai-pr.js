#!/usr/bin/env node
// ai-pr — 브랜치의 변경사항(diff)을 AI로 요약해 PR 본문(작업 내용/테스트 방법)을
// 만들고, 내용이 미리 채워진 GitHub PR 생성 페이지를 브라우저로 엽니다.

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HELP = `ai-pr — AI로 PR 본문을 만들어 GitHub PR 생성 페이지를 미리 채워 엽니다.

사용법:
  ai-pr [옵션]

옵션:
  -b, --base <branch>   비교 기준 브랜치 (기본: origin 기본 브랜치 자동 감지)
      --model <name>    Gemini 모델 지정 (미지정 시 여러 모델 자동 폴백)
      --print           브라우저를 열지 않고 본문을 콘솔에 출력
      --dry-run         AI 호출 없이 감지된 정보(브랜치/base/diff 크기)만 확인
  -h, --help            도움말

환경변수:
  GEMINI_API_KEY        (필수) Google AI Studio 발급 키
                        https://aistudio.google.com/apikey
  AI_PR_BASE            base 브랜치 기본값 (--base 로 덮어씀)
  AI_PR_MODEL           모델 기본값 (--model 로 덮어씀)

  위 값들은 아래 파일에서도 읽습니다 (KEY=VALUE 형식):
    현재 폴더의 .env.local, .env  또는  전역 ~/.ai-pr.env
`;

// 예상된 실패는 이 에러로 던지고 최상단에서 한 번만 처리한다.
// (process.exit()를 fetch 직후 호출하면 Windows에서 libuv assertion이 나므로
//  exitCode만 지정하고 이벤트 루프가 자연스럽게 끝나도록 둔다.)
class CliError extends Error {}

function fail(msg) {
  throw new CliError(msg);
}

// 간단한 인자 파서 (의존성 없이)
function parseArgs(argv) {
  const opts = { print: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--print") opts.print = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-b" || a === "--base") opts.base = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else fail(`알 수 없는 옵션: ${a}\n\n${HELP}`);
  }
  return opts;
}

// .env 파일에서 환경변수 로드 (의존성 없이). 이미 설정된 값은 덮지 않음.
// 우선순위: 현재 폴더 .env.local > .env > 전역 ~/.ai-pr.env
function loadEnvFiles() {
  const files = [
    join(process.cwd(), ".env.local"),
    join(process.cwd(), ".env"),
    join(homedir(), ".ai-pr.env"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    content = content.replace(/^﻿/, ""); // BOM 제거 (PowerShell Out-File utf8 대비)
    for (const line of content.split(/\r?\n/)) {
      let entry = line.trim();
      if (!entry || entry.startsWith("#")) continue;
      // 줄 전체가 따옴표로 감싸진 경우 벗겨냄 (예: "KEY=VALUE")
      if (
        entry.length >= 2 &&
        ((entry[0] === '"' && entry[entry.length - 1] === '"') ||
          (entry[0] === "'" && entry[entry.length - 1] === "'"))
      ) {
        entry = entry.slice(1, -1);
      }
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      // 키/값에 잘못 붙은 감싸는 따옴표 제거 (사용자 실수 방어)
      const key = entry.slice(0, eq).trim().replace(/^["']+|["']+$/g, "");
      let val = entry.slice(eq + 1).trim().replace(/^["']+|["']+$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// 비교에 쓸 실제 ref 결정: origin/<base> 우선, 없으면 로컬 <base>
function resolveBaseRef(base) {
  for (const ref of [`origin/${base}`, base]) {
    try {
      git(["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {
      /* 다음 후보 */
    }
  }
  fail(`base 브랜치 '${base}' (또는 'origin/${base}')를 찾을 수 없습니다. --base 로 지정하세요.`);
}

// origin 원격의 기본 브랜치 자동 감지 → 실패 시 develop/main/master 순으로 탐색
function detectBaseBranch() {
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return ref.replace(/^refs\/remotes\/origin\//, "");
  } catch {
    for (const cand of ["develop", "main", "master"]) {
      try {
        git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${cand}`]);
        return cand;
      } catch {
        /* 다음 후보 */
      }
    }
  }
  return null;
}

// origin URL에서 owner/repo 추출 (https/ssh 모두 지원)
function detectRepo() {
  const url = git(["config", "--get", "remote.origin.url"]);
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!m) fail(`origin 원격에서 GitHub owner/repo를 찾지 못했습니다: ${url}`);
  return { owner: m[1], repo: m[2] };
}

function openUrl(url) {
  if (process.platform === "win32") {
    // 'start'의 첫 인자는 창 제목이라 빈 문자열을 넣어줘야 URL이 인자로 안 먹힘
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function generateBody({ apiKey, models, log, diff }) {
  const prompt = `너는 시니어 개발자야. 아래 git 커밋 목록과 diff를 바탕으로 한국어 PR(Pull Request) 본문을 마크다운으로 작성해줘.

규칙:
- 반드시 아래 두 섹션만, 이 제목 그대로 포함해줘.
- 간결하게, 불필요한 서론/맺음말 없이 본문만 출력해줘.

## 작업 내용
- (핵심 변경사항을 항목별로. diff에 근거해서만)

## 테스트 방법
- (변경사항을 확인할 수 있는 단계별 절차 제안. AI 추정임을 감안해 검증 위주로)

[커밋 목록]
${log}

[diff]
${diff}`;

  const payload = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  let lastErr = "알 수 없음";

  // 모델을 순서대로 시도(폴백). Google이 모델을 폐기 전환 중이면 404가
  // 들쭉날쭉 나므로, 한 모델이 안 되면 다음 모델로 넘어간다.
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const maxAttempts = 3;
    let moveToNextModel = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
      } catch (e) {
        // 타임아웃(매달림)이면 다음 모델로, 그 외 네트워크 오류는 중단
        if (e.name === "AbortError") {
          lastErr = `${model}: 응답 시간초과(30초)`;
          console.error(`모델 '${model}' 시간초과 — 다음 모델 시도`);
          moveToNextModel = true;
          break;
        }
        fail(`Gemini 호출 실패(네트워크): ${e.message}`);
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const data = await res.json();
        const body = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (body && body.trim()) return body.trim();
        lastErr = `${model}: 빈 응답`;
        moveToNextModel = true;
        break;
      }

      // 503(과부하)/429(레이트리밋)은 일시적이므로 잠깐 뒤 재시도
      if ((res.status === 503 || res.status === 429) && attempt < maxAttempts) {
        const waitMs = 1200 * attempt;
        console.error(`모델 '${model}' 과부하(${res.status}) — ${waitMs}ms 후 재시도`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const text = await res.text().catch(() => "");
      lastErr = `${model} → ${res.status}: ${text.slice(0, 160)}`;
      console.error(`모델 '${model}' 실패(${res.status}) — 다음 모델 시도`);
      moveToNextModel = true;
      break;
    }
    if (moveToNextModel) continue;
  }

  fail(`모든 모델 호출 실패. 마지막 오류: ${lastErr}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  loadEnvFiles();

  // git 저장소인지 확인
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    fail("현재 위치가 git 저장소가 아닙니다.");
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = opts.base || process.env.AI_PR_BASE || detectBaseBranch();
  if (!base) fail("base 브랜치를 감지하지 못했습니다. --base 로 지정하세요.");
  if (branch === base) {
    fail(`현재 '${base}' 브랜치입니다. PR을 만들 기능 브랜치로 이동한 뒤 실행하세요.`);
  }

  const { owner, repo } = detectRepo();

  // base 최신화 (오프라인/원격 없음 등은 조용히 무시하고 로컬 기준으로 진행)
  try {
    execFileSync("git", ["fetch", "origin", base, "--quiet"], { stdio: "ignore" });
  } catch {
    /* 무시 */
  }

  const baseRef = resolveBaseRef(base);
  const log = git(["log", `${baseRef}..HEAD`, "--pretty=format:- %s"]);
  let diff = git(["diff", `${baseRef}...HEAD`]);

  if (!diff.trim()) fail(`${baseRef} 대비 변경사항이 없습니다.`);

  const MAX_DIFF = 12000;
  if (diff.length > MAX_DIFF) diff = diff.slice(0, MAX_DIFF) + "\n... (이하 생략)";

  if (opts.dryRun) {
    console.log(`repo:   ${owner}/${repo}`);
    console.log(`branch: ${branch}`);
    console.log(`base:   ${base}`);
    console.log(`커밋:\n${log}`);
    console.log(`diff 길이: ${diff.length}자`);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    fail(
      "GEMINI_API_KEY 환경변수가 없습니다.\n" +
        "https://aistudio.google.com/apikey 에서 키를 발급받아 설정하세요."
    );
  }
  // 명시적으로 모델을 지정하면 그것만, 아니면 폴백 체인을 순서대로 시도
  const explicit = opts.model || process.env.AI_PR_MODEL;
  const models = explicit
    ? [explicit]
    : ["gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];

  console.error("AI가 PR 본문 생성 중...");
  const body = await generateBody({ apiKey, models, log, diff });

  if (opts.print) {
    console.log(body);
    return;
  }

  const baseCompareUrl = `https://github.com/${owner}/${repo}/compare/${base}...${branch}`;
  const encoded = encodeURIComponent(body);

  // 브라우저/GitHub URL 길이 한계 → 너무 길면 본문만 출력하고 빈 창을 엶
  if (encoded.length > 6000) {
    openUrl(`${baseCompareUrl}?expand=1`);
    console.log(
      "\n본문이 길어 URL로 못 넣었습니다. 아래 내용을 복사해 PR 본문칸에 붙여넣으세요:\n"
    );
    console.log(body);
  } else {
    openUrl(`${baseCompareUrl}?expand=1&body=${encoded}`);
    console.error("PR 생성 창을 열었습니다. 내용 확인/수정 후 제출하세요.");
  }
}

main().catch((e) => {
  const msg = e instanceof CliError ? e.message : e?.stack || String(e);
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exitCode = 1;
});
