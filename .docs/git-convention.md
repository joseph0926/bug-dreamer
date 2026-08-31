# Git Convention

- 브랜치명: `type/short-slug` 형식. 예: `docs/initial-project-docs`
- 커밋 메시지: Conventional Commits의 `type(scope): subject` 또는 `type: subject` 형식. 제목은 영어 명령형으로 작성하고 72자 이내로 제한한다. 예: `docs: add project overview and v0.1 roadmap`
- Git 명령 제안: 커밋 단위마다 실제 대상 경로를 넣은 `git add <파일 경로...>`와 `git commit -m '<커밋 메시지>'`를 하나의 복사 가능한 shell 블록으로 제공한다. `git add .`은 제안하지 않는다.
- PR/MR 본문: GitHub PR을 사용하며 `Summary`, `Changes`, `Test` 구조로 작성한다.
- 근거: 2026-08-31 기준 정책 파일, 커밋 이력과 PR 템플릿이 없는 초기 GitHub 저장소에서 폴백 규칙을 적용했다.
