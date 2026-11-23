# 최종 출력 계약 (제안 초안)

작성 2026-11-04, IK·렌더 담당. **합의 전 제안이다.** BE 계약(`MICUT-backend` `contracts/v0`)과 FE API 명세(`api-v0.md`)에 맞춰
AI 파이프라인이 BE에 넘길 결과물의 형태를 정하려는 문서다. 합의되면 BE 계약 저장소로 옮기는 것을 제안한다.

## 1. 흐름

```text
BE job(pending) → AI 파이프라인: 기하 → 배치 → 포즈·IK·렌더 → 합성 → 결과 폴더 → BE가 읽어 job 갱신(done / failed)
```

BE는 결과 폴더의 `result.json`만 읽는다. 단계별 중간 파일은 디버깅용으로 남기되 앱에는 노출하지 않는다.

## 2. 결과 폴더

```text
results/<job_id>/<attempt>/
├─ final.jpg          # 앱에 보여주고 저장하는 사진 (status=done일 때만)
├─ result.json        # BE가 읽는 유일한 파일
└─ debug/             # 앱 비노출. 평가·디버깅용
   ├─ character.png           # 투명 배경 미쿠 렌더
   ├─ occlusion_mask.png      # 가림 확인용
   ├─ model_manifest.json     # 모델·포즈·IK 보고
   ├─ placement_report.json   # 화면 잘림·시간
   ├─ decision.json           # 배치 선택 근거
   └─ compose_report.json     # 가림 통계
```

## 3. `final.jpg`

| 항목 | 제안 |
|---|---|
| 형식 | JPEG, 품질 92, sRGB |
| 방향 | 똑바로 선 상태로 저장(회전 적용 완료). EXIF 방향 태그 없음 |
| 메타데이터 | EXIF·GPS 제거 (기하 단계와 동일) |
| 해상도 | **11/9 데모: 기하 처리 해상도(768×1024, 긴 변 1024).** 이후 원본 해상도로 올릴지 결정 필요 |

원본 해상도(예: 4284×5712)로 올리려면 렌더 카메라 K를 비율대로 키우고 깊이·마스크를 확대해 합성하면 된다.
렌더 시간이 해상도에 비례해 늘어나므로 데모 이후 실측 후 정한다.

## 4. `result.json`

성공:

```json
{
  "schema": "micut.result/0.1",
  "job_id": "j_20261105_a1b2c3d4e5f6",
  "attempt": 1,
  "status": "done",
  "image": {"file": "final.jpg", "width": 768, "height": 1024, "format": "jpeg",
            "color_space": "sRGB", "orientation": "upright"},
  "tags": [],
  "placement": {"action": "sit", "pose_id": "sit_default", "anchor_type": "pelvis_seat_contact",
                "anchor_position": [0.874, 0.445, 1.481], "support_candidate_id": 2, "selection": "rule"},
  "quality": {"fully_in_frame": true, "visible_vertex_fraction": 1.0, "occluded_fraction": 0.096,
              "feet_on_floor": true, "warnings": [],
              "checks": {"preserve": {"status": "pass", "items": [{"side": "right", "part": "fingers", "gesture": "peace", "status": "pass"}]},
                         "penetration_scene": {"status": "not_run", "reason": "geometry has no depth_validity.png ..."}}},
  "timing_s": {"geometry": 0.0, "placement": 0.0, "render": 0.0, "compose": 0.0, "total": 0.0},
  "versions": {"model_id": "legend-pretty-miku-local-v1", "model_sha256": "...",
               "commits": {"depth": "...", "placement": "...", "ik": "..."}},
  "error": null
}
```

실패:

```json
{
  "schema": "micut.result/0.1",
  "job_id": "j_20261105_a1b2c3d4e5f6",
  "attempt": 1,
  "status": "failed",
  "image": null,
  "error": {"code": "NO_VALID_PLACEMENT", "stage": "placement",
            "message": "미쿠가 설 자리를 찾지 못했어요. 바닥이 더 넓게 나오게 다시 찍어주세요",
            "retryable": false, "detail": "NO_VALID_CANDIDATE: 0 of 38 floor cells passed"}
}
```

### BE job으로 옮기는 규칙

| `result.json` | BE job |
|---|---|
| `status` | `status` (`done` / `failed`) |
| `image.file` | 업로드 후 `result.image_url` |
| `tags` | `result.tags` |
| `error.code`, `error.message`, `error.retryable` | `error` (BE 오류 형식 그대로) |
| `placement`, `quality`, `timing_s`, `versions`, `error.detail` | BE 내부 로그만. 앱에 보내지 않음 |

## 5. 오류 코드 대응

BE 오류 코드표에 있는 것은 그대로 쓰고, 없는 두 개는 추가를 제안한다.

| 원인 (단계) | BE 코드 | retryable | 앱 동작 |
|---|---|---|---|
| 바닥을 못 찾음 (기하, 바닥 평면 적합률 낮음) | **`FLOOR_NOT_FOUND` (신규 제안)** | false | 다시 찍기 |
| 배치 후보 0개 (배치 `NO_VALID_CANDIDATE`) | **`NO_VALID_PLACEMENT` (신규 제안)** | false | 다시 찍기 |
| 사람 없음 / 발 신뢰도 낮음 (사람인식, **데모에는 없음**) | `PERSON_NOT_FOUND` / `FOOT_LOW_CONFIDENCE` | false | 다시 찍기 |
| 렌더 프로세스 실패 (Blender 오류·크래시) | `RENDER_FAILED` | true | 다시 시도 |
| 시간 초과 | `AI_TIMEOUT` | true | 다시 시도 |
| 단계 간 계약 위반 (렌더 `INVALID_PLACEMENT`, `SUPPORT_OUT_OF_RANGE`, `MODEL_MISMATCH`) | `INTERNAL_ERROR` | 검토 필요 | 다시 시도 |

계약 위반은 파이프라인 버그라 다시 시도해도 같은 결과가 나온다. BE 표의 `INTERNAL_ERROR`는 `retryable: true`라서 이 경우만 false로 둘지 정해야 한다.

## 6. 합의할 것

| # | 결정 사항 | 같이 정할 사람 | 제안 |
|---|---|---|---|
| 1 | 결과 폴더·`result.json` 형식과 BE 매핑 | BE(윤종욱·박유진) | 위 4절 |
| 2 | 신규 오류 코드 2개와 문구 | BE, FE(진유진·고연오) | 위 5절 |
| 3 | `final.jpg` 해상도 | FE, BE, 기하(서석훈) | 데모 768×1024, 이후 실측 후 결정 |
| 4 | `final.jpg`를 만드는 단계의 담당 | 합성(신소연), 배치(정성윤), IK·렌더(조민재), PM | **확정 (2026-11-04): 데모는 IK·렌더(조민재)가 맡음.** 데모에는 사람인식(MediaPipe) 단계가 없어 합성 파트가 쉬므로, 렌더 쪽이 정성윤님 `micut_place.compose`(깊이 가림)를 수정 없이 호출하고 그 위에 그림자·색 보정을 얹어 `final.jpg`까지 만든다. v1 고급 후처리부터는 합성 담당(신소연님)에게 넘기거나 같이 정한다 |
| 5 | 화면 잘림·가림 품질 기준: 어디까지 `done`이고 어디부터 `failed`인지 | PM님, 배치 | 예: 머리가 잘리거나 보이는 정점 80% 미만이면 `NO_VALID_PLACEMENT` |
| 6 | 단계를 순서대로 실행하는 주체(오케스트레이터) | PM, BE | 한 워커가 기하→배치→렌더→합성을 실행하고 `result.json`을 씀 |
| 7 | `tags`를 만드는 주체 | BE, 기하 | 미정. 데모에서는 빈 배열 허용 |

## 7. 현재 렌더 측 실측

- 이 노트북(CPU Cycles, 768×1024, 16샘플): 렌더 단계 케이스당 약 8~10초 (Blender 시작·포즈·렌더 포함)
- 합성 단계 시간은 아직 따로 재지 않음
