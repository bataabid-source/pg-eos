# tests/ops/x-part-20.feature — X part 20 item 1 (pg-tester).
#
# Gate ⑦ (image build + compose smoke) moves from per-PR ci.yml to nightly.yml + workflow_dispatch
# (CLAUDE.md · Merge queue, ADR-0007 D-197). Brief: docs/notes/slice-briefs/_slice-X-p20-image-nightly.brief.md.
# Executable spec: tests/ops/tests/x-part-20.test.ts.

Feature: X part 20 — gate ⑦ runs nightly, not per PR

  Scenario: per-PR CI carries gates one to six only
    When .github/workflows/ci.yml is read
    Then it has no job key image and no job name containing "⑦"
    And its jobs block uses neither docker/build-push-action nor docker/setup-qemu-action
    And its triggers keep pull_request and push
    And the jobs static, test, acceptance, guards and security still exist

  Scenario: nightly.yml carries the gate seven image job
    When .github/workflows/nightly.yml is read
    Then it has a job image named "⑦ build images (linux/arm64) + compose smoke" with timeout-minutes 45
    And it builds with docker/build-push-action@v6 for linux/arm64 with push false and for linux/amd64 with load true tagged pg-eos/app:local
    And it runs docker compose up -d --wait, GET http://127.0.0.1:3000/health and the worker log probe for "relay loop starting"
    And it tears down with docker compose down -v under if: always()
    And its env sets COMPOSE_FILE, WORKER_LOG_RETRIES, WORKER_LOG_RETRY_SECONDS and COMPOSE_WAIT_TIMEOUT_SECONDS

  Scenario: nightly.yml triggers are schedule and workflow_dispatch only, and each job has its own concurrency group
    When .github/workflows/nightly.yml is read
    Then its on block keys are exactly schedule and workflow_dispatch, with no pull_request
    And there is no workflow-level concurrency block
    And job mutation has concurrency group nightly-mutation with cancel-in-progress false, and job image has concurrency group nightly-image with cancel-in-progress true
    And the mutation job still exists with its name, timeout-minutes 180 and the command pnpm -s mutation
