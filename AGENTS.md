# AGENTS.md

## 문서 소유권

- [README.md](README.md)는 현재 제품 개념, 검증된 결과, 공개 동작 흐름과 알려진 한계를 소유한다.
- [docs/ROADMAP.md](docs/ROADMAP.md)는 버전별 범위, 제외 범위, phase, 현재 상태와 adopt, revise, retire 판정을 소유한다.
- [docs/V0.1-CONTRACT.md](docs/V0.1-CONTRACT.md)는 v0.1과 v0.2의 변경 불가 역사 실행 계약, 결과 분류, 실행 증거, 재현 판정과 보고서 형식을 소유한다.
- [docs/V0.3-CONTRACT.md](docs/V0.3-CONTRACT.md)는 v0.3 입력, 실행, 결과 축, evidence, 재현, 최소화, 게시와 validator 계약을 소유한다.
- [docs/adr/0001-data-only-evaluation-boundary.md](docs/adr/0001-data-only-evaluation-boundary.md)는 generator, target, fixture materializer, interpreter와 result channel의 신뢰 경계 결정과 이유를 소유한다.
- [CONTEXT.md](CONTEXT.md)는 버전 간에 공유하는 도메인 용어의 뜻만 소유한다.
- ROADMAP의 v0.2 절, 당시 registration과 results는 v0.2 확장 범위와 실제 판정의 audit trail이다.
- [.docs/git-convention.md](.docs/git-convention.md)는 브랜치명, 커밋 메시지와 PR 본문 형식을 소유한다.
- 제품 소개와 사용자 대상 문서는 기존 문서의 영어 문체를 따른다.

## 제품 불변식

- Bug Dreamer는 드물지만 도달 가능한 상태를 상상하고 이를 실행 가능한 테스트로 바꾼다.
- 보고서에는 격리 환경에서 실행되어 실제로 실패한 테스트만 포함한다.
- 통과한 테스트와 실행할 수 없는 테스트는 보고서에서 제외한다.
- 환경 오류, 테스트 준비 오류와 잘못 정의한 기대값을 제품 버그로 분류하지 않는다.
- 실패 테스트의 기대값은 시나리오 생성과 독립적인 제품 계약 근거를 가리켜야 한다.
- 재현 명령과 실행 증거가 없는 시나리오는 그럴듯해도 보고하지 않는다.
- 실제 버그인지, 고칠 가치가 있는지는 사용자가 최종 판정한다.

## 버전 경계

- 구현 범위는 항상 [docs/ROADMAP.md](docs/ROADMAP.md)에서 확인한다. v0.2는 2026-08-31에 완료됐다.
- 구현된 범위는 한 저장소(firsttx)의 등록 모듈에 대한 격리 실행, 배치 실행기, 사전 등록 품질 게이트가 있는 픽스처 벤치마크, 하루 최대 1회의 후보 다이제스트까지다. 기본 시나리오 생성 설계는 separated(불변식 우선)다.
- 여러 저장소 지원, 웹 인터페이스, 자동 수정과 스타트업 트랙 기능(shadow customers, bounty, underwriting)은 구현하지 않는다.
- 다음 버전 아이디어는 ROADMAP의 범위와 완료 조건이 먼저 바뀌지 않는 한 구현하지 않는다.
- 격리 실행기와 실행 증거 형식은 이 저장소 안에서 먼저 검증한다. 실제 두 번째 소비자가 생기기 전에는 공유 패키지나 별도 저장소로 추출하지 않는다.

## 실행 안전

- 생성된 테스트와 대상 프로젝트 명령은 호스트에서 직접 실행하지 않는다.
- 일회용 격리 환경에서만 실행하고 네트워크 차단, 명령 허용 목록, 시간 제한과 자원 제한을 적용한다.
- 대상 프로젝트의 비밀, 자격 증명과 개인 설정을 격리 환경에 전달하지 않는다.
- 실행 결과는 최소한 통과, 실패, 실행 불가로 구분한다. 인프라 실패와 테스트 정의 실패는 제품 실패와 별도로 기록한다.
- 실행기 자체의 시간 또는 자원 제한으로 오라클 평가를 마치지 못하면 실행 불가로 분류한다.
- v0.1과 v0.2 실행 증거에는 [docs/V0.1-CONTRACT.md](docs/V0.1-CONTRACT.md)가 정한 필드를 남긴다. v0.3 실행 증거는 [docs/V0.3-CONTRACT.md](docs/V0.3-CONTRACT.md)를 따른다.

## 변경 경계

- 목표, 범위, 제외 범위, 상태 전이, 권위, 불변식 또는 완료 조건이 달라지면 구현 전에 이를 소유하는 문서를 갱신한다.
- 시나리오 생성과 실행 검증의 판단 근거를 분리한다. 같은 주장을 생성 결과만으로 승인하지 않는다.

## 테스트와 완료 조건

- 실행 결과 분류를 구현하면 통과, 실패, 실행 불가 사례를 각각 테스트한다.
- 보고서 선별을 구현하면 통과와 실행 불가 결과가 제외되는 회귀 테스트를 둔다.
- 격리 실행을 구현하면 네트워크 차단, 명령 허용 목록, 시간 제한과 자원 제한의 경계를 검증한다.
- 보고된 실패는 해당 버전 계약이 정한 기록된 격리 명령으로 다시 실행해 같은 실패 시그니처를 관측해야 한다.
- 자동 검증이 통과해도 사용자가 악몽 하나 이상을 고칠 가치가 있다고 판정하기 전에는 v0.1 완료를 주장하지 않는다.
- 호스트 명령은 Node.js 24로 실행한다. 특정 버전 관리자를 전제하지 않는다.
- 단위 테스트는 `node --test test/*.test.mjs`로 실행한다. `test/fixtures/`의 시나리오는 호스트에서 실행하지 않는다.
- v0.1과 v0.2 Docker 이미지 준비는 `node scripts/prepare-image.mjs --target <firsttx 경로> [--module <모듈>]`로 실행한다. 이 명령만 이미지와 락파일 의존성을 내려받기 위해 네트워크를 사용할 수 있다.
- v0.1과 v0.2 시나리오는 `node scripts/run-scenario.mjs --scenario <테스트 파일> [--module <모듈>]`로 저장소 루트에서 실행한다. 이 명령은 Docker 네트워크를 차단한다.
- v0.1과 v0.2 배치는 `node scripts/run-batch.mjs --dir <시나리오 디렉터리> [--module <모듈>]`로 실행한다. 각 시나리오를 기본 3회 연속 실행해 시그니처 일치 여부를 집계하며 리포트는 생성하지 않는다.
- v0.1과 v0.2 모듈 실행 계약은 동결된 `src/modules.mjs`가 소유한다. 미등록 모듈 지정은 잘못된 실행기 입력(exit 2)이며 격리 속성은 모듈별로 완화할 수 없다. 기본 모듈은 `packages/tx`다. v0.3 module registration은 별도 v0.3 경로와 계약에 둔다.
- v0.2 벤치마크 결함은 동결된 `benchmark/manifest.json`이 소유한다. 결함 이미지는 `node scripts/prepare-image.mjs --target <경로> --defect <결함 id>`로 빌드한다. 실행은 `--defect <결함 id>`로 지정한다. 각 결함의 check 시나리오는 결함 이미지에서 candidate-failure, 정상 이미지에서 pass여야 한다. v0.3 benchmark registration은 `benchmark/v0.3/`가 소유한다.
- v0.2 다이제스트는 `node scripts/run-digest.mjs --dir <시나리오 디렉터리> [--module <모듈>] [--model-calls <생성 세션 model call 수>]`로 생성하며 `digests/YYYY-MM-DD.md`와 배치 실행 증거 `evidence/YYYY-MM-DD/digest-batch.json`을 쓴다. 시나리오가 20개를 넘으면 실행 전에 거절한다. 다이제스트는 실행 시간과 전달받은 model call 수를 기록하며 각 후보가 배치 증거를 참조한다. 다이제스트 항목은 후보일 뿐이며 `nightmares/` 승격은 독립 재현과 사람 판정을 요구하는 v0.1 규칙을 그대로 따른다. 어떤 자동 실행도 `nightmares/`에 직접 쓰지 않는다. 스케줄 등록은 사용자 몫이고 하루 최대 1회 배치가 계약이다.
- v0.3은 별도 runner, harness와 image namespace를 사용한다. 기존 runner, harness, Dockerfile과 v0.2 image tag를 수정하거나 덮지 않는다.
- v0.3 구현과 검증 명령은 [docs/V0.3-CONTRACT.md](docs/V0.3-CONTRACT.md)의 CLI 계약을 따른다.
- 현재 확정된 lint와 typecheck 명령은 없다.
