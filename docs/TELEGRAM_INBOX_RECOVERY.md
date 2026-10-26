# Telegram 수신 내구성·21 WSL 복구

2026-10-26. 이 문서는 시작 시각 이전 메시지를 버리던 동작을 대체한다.

## 고친 문제

- `tg-update-stale` 시간 기준 제외를 제거했다. 오프라인 동안 온 지시도 수신한다.
- Telegram getUpdates의 다음 offset으로 확인하기 전에 원문을 저장한다.
- 저장 실패·손상·수신함 한도 초과 시 offset을 전진시키지 않는다.
- 미착수 pending은 재시작 후 처리한다. dispatching 상태에서 중단된 것은
  needs_review로 보존하고 원문 재전달/취소 버튼으로 알린다. 자동 반복 실행하지 않는다.
- 텍스트 batch는 지연 타이머·수동 batch가 끝나기 전에 완료로 표시하지 않는다.
- `/stop`이 포함된 batch의 다른 지시는 조용히 버리지 않고 보존·확인 대상으로 둔다.
- 처리 완료 ID는 제한된 이력에 남겨 중복 수신을 막고 완료 원문은 제거한다.

데이터: DATA_DIR/telegram-inbox/<numeric-bot-id>.json. 디렉터리 700, 파일 600.
미해결 최대 1,000개, 완료 ID 최근 10,000개를 보존한다. 보존된 원문에 시크릿
등록 메시지가 있을 수 있으므로 에이전트 문서에 복사하거나 로그로 출력하지 않는다.
실행 중 종료된 작업은 이미 외부 부작용을 만들었을 수 있다. exactly-once 실행을
보장하지 않으며 불명확한 실행은 반드시 확인 후 재전달한다.

로컬 파일 fsync+atomic rename으로 수신 데이터를 보관한다. 하드웨어 고장·디스크
전체 손실까지 해결하는 백업은 아니다. 기본 수신함은 Telegram 개인 owner 채팅
복구를 우선 지원한다. 다른 채팅/비메시지 업데이트도 보존하지만 재전달 버튼은
현재 private owner 메시지에만 제공한다.

## Windows/WSL 유지

Windows PowerShell에서 현재 사용자로 실행:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\au212\projects\remoteagent\scripts\install-wsl-runtime.ps1 -Distribution Ubuntu
Get-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
Get-ScheduledTaskInfo -TaskName 'RemoteAgent-WSL-Ubuntu'
```

로그인 시 + 1분 간격 트리거, 중복 실행 IgnoreNew, 실패 시 1분 재시도다.
WSL 유지용 sleep만 실행하며 Telegram 수신기는 기존 user service 하나다.
WSL이 정상 종료 코드로 내려가도 다음 반복 트리거가 다시 시작한다.
Windows 절전·로그아웃·전원 종료 중 서비스는 보장하지 않는다.
개발 중 의도적으로 WSL을 내릴 때 먼저 작업을 비활성화한다.

```powershell
Disable-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
Stop-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
# 재개
Enable-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
Start-ScheduledTask -TaskName 'RemoteAgent-WSL-Ubuntu'
```

## 검증

```bash
npm run check
npm run build
node --test scripts/selftest-telegram-inbox.mjs scripts/selftest-telegram-questions.mjs
npm run selftest:telegram
node --test scripts/selftest-runtime-lock.mjs scripts/selftest-polling-subscription.mjs
```

배포 전 실행 작업을 확인하고 상태·시크릿·설정을 백업한다. 기존 S001을 삭제하거나
새로 만들지 않는다. 기존 버전에서 이미 확인 처리 후 버린 Telegram 메시지는
Bot API로 과거 이력을 다시 받을 수 없다. 남은 로그·원문 첨부·세션 기록에서
회수한 범위를 밝히고, 잘린 로그를 완전한 원문으로 꾸미지 않는다.

## 2026-10-26 21 적용 결과

- 릴리스 f38c0c4, npm 0.32.2 게시와 latest 일치 확인.
- npm artifact SHA-1: 181bc62f28cabe661d28ecbfe4288677dbc19ac8.
- 릴리스의 전체 검증 게이트 및 수신함/질문 9개 단위 시험 통과.
- Telegram 주입 통합 시험에 오래된 날짜의 입력과 수동 batch 영속 receipt 검사 추가·통과.
- 정상 종료 코드 0의 별도 Windows 시험 작업이 13:49:16, 13:50:17에
  반복 실행됨을 확인하고 시험 작업을 제거했다. 실제 WSL 강제 종료 시험은 아니다.
- 정식 `npm run release:deploy -- 0.32.2 21`로 설치, 기존 state와
  Secret Store 비교 통과. S001 thread와 workspace 유지.
- 백업: /home/au212/.remoteagent/backups/npm-0.32.2-20261026T134721.
- 설치본 롤백 archive는 npm prepare가 없는 직접 tar 방식으로 수정,
  배포 도구 보완 커밋 6c24ad0. 다음 배포에도 저장소의 정식 스크립트를 사용한다.
- S001의 기존 thread에 복구 기록을 전달하고 답변까지 수신했다. 완전한
  텍스트 지시가 공용 문서에 반영됐고 기존 ZIP 해시 불변을 보고받았다.
- 4시안 제작은 후속 미완료 작업이다. 잘린 직업별 원문과 첨부 2건은 미복구다.
- 복구 결과를 기존 Telegram 채팅에 전송, API message_id 177 확인.
- WSL 자체가 종료된 근본 원인은 미확정이다. 이번 변경은 종료 후 자동
  재기동과 신규 수신 유실 방지이며 OS 장애 자체의 완치를 주장하지 않는다.
