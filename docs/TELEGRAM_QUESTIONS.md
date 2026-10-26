# Telegram 선택 질문

2026-10-25: 구현 후보. 기존 Codex exec 기반 실행을 유지하고 명시적 구조화
질문만 Telegram 버튼으로 전달한다. Codex 앱의 request_user_input 도구를
직접 중계한 구현은 아니다. 일반 문장의 단어로 질문·작업을 판정하지 않는다.

에이전트가 사용자 결정이 필요할 때만 아래 형식으로 반환한다.

```text
REPORT:blocked
TELEGRAM_QUESTION: {"question":"시간 진행 방식은?","options":["턴제","실시간","혼합"]}
```

선택지는 2~5개, 각 80자 이하이며 서버가 `기타 (직접 입력)`를 추가한다.
선택은 원래 bot/chat/session에 사용자 답변으로 전달한다. 기타는 Telegram
ForceReply로 입력창을 열며, 입력 전에는 모델을 실행하지 않는다.
버튼 없이 직접 답해도 정상 전달하고 이전 질문 버튼은 무효화한다.
한 번 선택한 버튼의 재클릭은 실행하지 않는다. 소유자와 세션 연결을 확인한다.
질문을 이유로 사용자 텍스트를 거부하거나 선택지를 강제하지 않는다.
이미 받은 자유 답변을 읽고 판단하는 책임은 담당 LLM에 있다.

질문 상태는 6시간 TTL/1,000개 제한의 메모리 저장이다. 재시작하면 이전
버튼은 만료된다. 이때 텍스트로 답할 수 있고 대화 세션은 보존된다.
현재 한 번의 보고에 질문 하나를 지원한다. 잘못된 JSON은 일반 응답으로
전달하며 임의로 선택지를 만들어내지 않는다.

검증:

```bash
npm run build
node --test scripts/selftest-telegram-questions.mjs
npm run selftest:telegram
```

단위: 명시적 포맷 검증, 범위/세션/만료, 재클릭, 기타, 텍스트 무효화.
Telegram 주입 통합: 버튼 생성, 클릭 답변 라우팅, 중복 클릭,
기타 ForceReply, 자유 텍스트 답변. 실제 Telegram 기기 시험과 구분한다.

## 21 WSL 서비스 유지 보완

16:40 WSL 재기동 이후 runtime이 자동 시작된 것을 확인했다.
그 전 중단이 WSL idle인지 사용자 종료·재부팅인지는 확인되지 않았다.
실제 로그의 `[tg-update-stale]`에서 16:32의 VR/싱글·멀티 답변이 재시작
이전 메시지라는 이유로 제외된 것을 확인했다. 선택 버튼 미사용으로 인한
거절이 아니며, 이번 선택 질문 패치가 해당 시간 기반 제외 정책까지
수정한 것은 아니다. 오래된 메시지를 모두 자동 재실행하는 변경은 피하고,
후속 수신 내구성 작업에서 영속 receipt/inbox와 중복 실행 방지를 함께 설계한다.
WSL systemd 서비스만으로 Windows 측 WSL 실행 수명이 보장된다고 가정하지 않는다.
Windows 작업 스케줄러 `RemoteAgent-WSL-Ubuntu`를 현재 사용자 로그인 시
`wsl.exe -d Ubuntu --exec /bin/sleep infinity`로 시작하도록 등록했다.
추가 Telegram 수신기 없이 배포판을 유지한다. 기존 사용자 RemoteAgent
서비스가 실제 수신을 담당한다. Windows 로그아웃·절전·강제 WSL 종료
상태에서는 수신을 보장하지 않는다. 재부팅/로그인 실시험은 별도다.

확인/종료 명령(Windows PowerShell):

```powershell
Get-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
Stop-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
```

단순 `/start`로 세션을 새로 만들거나 작업을 자동 재전송하지 않는다.
배포·재시작 시에는 실행 작업을 먼저 확인한다. 후보 구현을 현재 npm
설치본에 반영됐다고 보고하지 않는다.
