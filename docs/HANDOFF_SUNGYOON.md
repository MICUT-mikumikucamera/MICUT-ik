# 성윤님 전달용 모델·좌표·포즈 기준

2026-11-04 갱신. 이전(10/30) 내용 중 바뀐 것은 표시함. 착석 계약은 성윤님 `docs/SEATING_PREP.md` 제안을 그대로 받았다.

## 1. 모델·렌더 환경

- 렌더: VRM 경로(three.js, `tools/render_vrm.mjs`)로 전환 중(11/13 회의). Blender 5.2 Cycles 경로도 유지. 두 경로는 같은 입력·포즈를 받고 manifest 수치가 같음(서기 1e-6 m 이내, 앉기 크기 차 2 mm 이내 확인)
- 테스트 모델: `legend_pretty_miku_refuv.blend` (**임시**. 최종 공통 모델은 미정)
- 최종 모델이 오면 `examples/model_profile.json`만 다시 쓰고, 그때 manifest를 새로 드림. 입력 형식은 그대로

## 2. 크기

- 1단위 = 1 m. 키 **1.58 m 확정**(신발 바닥~머리카락 끝, 기본 자세 기준).
- 배율은 렌더 쪽에서 포즈 적용 전 한 번 계산(약 1.0198). 사진·포즈에 따라 바뀌지 않음.
- `stand_default` 외형: 가로 약 0.645 m, 앞뒤 약 0.519 m. 앞뒤는 비대칭(앞 0.10 m, 뒤 0.42 m)이라 manifest의 `normalized_local_bounds_m` 사용.

## 3. 위치 기준점

| 포즈 | `anchor_type` | 기준점 |
|---|---|---|
| 서기 | `feet_center_on_ground` | 양발 발바닥 사이 바닥점, Y = 0 |
| 앉기 | `pelvis_seat_contact` | 좌판 위 골반(좌골) 접촉 중심, Y = 좌판 높이 (0.30~0.60 m) |

모델 원점과의 차이는 렌더 쪽에서 보정. 골반 접촉점은 렌더 쪽에서 메시로 계산함.

## 4. 좌표

- 기하 월드 좌표 그대로(미터, X 오른쪽, Y 위, Z 앞, 카메라 아래 바닥 원점). 축 변환은 렌더 쪽.
- 배치에 쓴 사진의 `spatial_info.json`을 같이 주세요. fx·fy·cx·cy 없으면 오류.

## 5. 방향·포즈

- 등록 포즈: `stand_default`, `stand_natural`, `sit_default`, 그리고 PM님 프리셋 저장소(micut-presets) v0.6.5의 28개(`MV01`~`MV15`, `COL_*` 12개, `EX01`, 전부 `action=stand`, 목록은 `presets.lock.json`). 다른 `pose_id`는 `pose_ref`가 없으면 오류.
- 새로 조합한 포즈(2026-11-19 추가, VRM 렌더만): `pose_id`(등록 포즈와 겹치지 않는 새 ID)와 `pose_ref`(작업창 내보내기 JSON, `placement.json` 기준 상대 경로)를 같이 주세요. `action`·`anchor_type`은 그 포즈의 기본 자세에 맞춰야 합니다. 의자 기본 자세(`B05`~`B07`)는 `action=sit`, `pelvis_seat_contact`이고 다리는 실제 좌판 높이에 맞춰 렌더 때 다시 맞춥니다. 자세한 규칙은 `docs/POSE_IK.md`.
- 방향: `look_at_camera`(수평 회전만) 또는 `world_direction` + `facing_direction: [x, 0, z]`. 각도 단독 입력은 받지 않음.
- 소파처럼 앞이 정해진 좌석은 `world_direction`으로 좌석 앞 방향을 주세요.

## 6. 착석 (SEATING_PREP 대응)

| SEATING_PREP 항목 | 상태 |
|---|---|
| `action=sit`, `pose_id=sit_default` | 반영. 의자 기본 자세의 `pose_ref` 포즈도 받음(좌판 0.30~0.60 m, 높은 좌석 `B07`은 0.55~0.90 m) |
| `anchor_type=pelvis_seat_contact`, Y = 좌판 높이 | 반영. 범위 밖이면 `SUPPORT_OUT_OF_RANGE` |
| `support_candidate_id` | 반영 (manifest `support`에 기록만) |
| `combo` (선택, 포즈 후보의 조합, 2026-11-23) | 등록 포즈(`pose_id` = 후보의 `combo_ref`)면 그 프리셋과 조합 해시가 같아야 함. 다르거나 등록 포즈가 아닌데 `pose_ref`가 없으면 `INVALID_PLACEMENT`. `pose_ref`가 있으면 기록만. Blender 경로는 거부 |
| `preserve` (선택, 포즈 후보의 `preserve` 그대로, 2026-11-23) | 보정 뒤 그 부위가 그대로인지 manifest·`result.json`의 `checks.preserve`(`pass`/`fail`/`not_run`)로 남김. 머리 계열이면 시선 보정을 안 함 |
| `selection` (선택, 문자열: `rule` / `jev` / `manual`) | 2026-11-16 추가. 배치 쪽 선택 방식. manifest와 `result.json`의 `placement.selection`으로 그대로 전달, 없으면 `"unknown"` |
| 골반·발 접촉점 | manifest `contacts` |
| 몸 충돌 프록시 | manifest `body_collision_proxy` (캡슐 14개, 머리카락·치마·소매 제외) |
| 포즈별 형상 내보내기 | `render_stand.py --export-shape` → `shape.npz` (`export_stand_shape.py`와 같은 형식) |
| 실패 응답 형식 | `error.json`에 `code` 추가: `INVALID_PLACEMENT`, `SUPPORT_OUT_OF_RANGE`, `MODEL_MISMATCH`, `RENDER_FAILED` |

추가로 부탁드릴 것:
- **좌판 앞 가장자리 위치.** 지금은 몰라서 허벅지가 좌판 안쪽에서 최대 약 1 cm 묻힘. 앞 가장자리를 주시면 그 너머에서만 허벅지를 내리게 바꿀 수 있음.
- 허용 접촉 부위(등받이에 등, 테이블에 손 등)는 기대기 포즈(v2) 때 같이 정하면 됨.

## 7. manifest 새 항목

- `local_frame`: **x = 캐릭터 오른쪽(r = [f_z, 0, -f_x]), y = 위, z = 바라보는 방향, 원점 = anchor.** `micut_place.shape`와 같은 축으로 맞춤.
  이전 렌더 manifest의 x는 캐릭터 왼쪽이었음. `stand_default`는 좌우 대칭이라 수치 변화 없음.
- `contacts`, `support`, `body_collision_proxy`, `pose_report`(IK 도달·발 접지·허벅지 각도·시선), `penetration_below_support`(지지면 아래 정점 수).
- `normalized_size_m.height`는 포즈의 실제 높이. 앉으면 1.58보다 작음. 키 기준은 `target_height_m`.
- 성윤님 `load_stand_model`은 `stand_default`만 받으므로, 다른 포즈는 `tools/compose_depth.py`처럼 shape를 직접 읽는 경로가 필요.

## 8. 깊이 합성

성윤님 `micut_place.compose`를 수정 없이 씀. 모든 포즈에 쓰도록 `tools/compose_depth.py`가 `shape.npz`를 직접 넘김.
sample1 테이블 뒤 테스트 위치에서 캐릭터의 9.6%가 테이블에 가려져 지워짐을 확인함.

## 9. sample1 참고

테스트 위치는 배치 판정을 거치지 않은 점들임(`examples/placement.sample1.*.json`).
좌석 2·3은 사진 가장자리라 앉으면 머리가 잘리고, 테이블 뒤 서기 위치는 상판 범위 안이라 실제로는 충돌함.
