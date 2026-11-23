# 포즈·IK 준비

작성 2026-11-04. 최종 모델이 정해지기 전이라 **임시 모델(`legend_pretty_miku_refuv.blend`)로 전체 흐름을 검증한 작업물**이다.
모델이 바뀌면 코드는 그대로 두고 `examples/model_profile.json`만 새 모델 기준으로 다시 쓴다.

## 구성

| 파일 | 역할 |
|---|---|
| `poses/*.json` | 포즈 정의. 방향은 캐릭터 기준 `[오른쪽, 위, 앞]`이라 모델이 바뀌어도 재사용 가능 |
| `examples/model_profile.json` | 모델 전용 정보: 휴머노이드 뼈 매핑, 손가락·치마·머리카락 뼈, 표정 셰이프 키, 착석 접촉·몸 프록시 vertex group |
| `micut_ik/ik.py` | 엔진과 무관한 IK 수학 (2관절 IK, 착석 발 목표, 각도 제한). Blender 없이 단위 테스트 |
| `micut_ik/posing.py` | Blender에서 포즈 단계 적용, 다리·팔 IK, 시선, 표정, 머리카락·치마 정리, 몸 프록시 계산 |
| `micut_ik/contracts.py` | 배치 입력 검증. 등록된 포즈만 받음 |
| `tools/run_testset.py` | 고정 테스트 세트 렌더 → 최종 합성 → 비교 시트 |
| `tools/finalize.py` | 사진 + 미쿠 + 그림자 + 깊이 가림 → `final.jpg`, `result.json` |
| `tools/compose_depth.py` | 성윤님 저장소의 `micut_place.compose`를 모든 포즈에 쓰도록 연결 |

원본 `.blend`는 수정하지 않는다. 배율은 포즈를 적용하기 **전** 기본 자세에서 한 번 계산하므로 포즈가 바뀌어도 키 기준(신발 바닥~머리카락 끝 1.58 m)은 같다.

## 포즈

| `pose_id` | `action` | `anchor_type` | 내용 |
|---|---|---|---|
| `stand_default` | stand | `feet_center_on_ground` | 기존 연결용. 팔만 75° 내림. 이전 manifest 수치와 같음 |
| `stand_natural` | stand | `feet_center_on_ground` | 오른발에 체중, 골반 2.5 cm 내림, 팔 자연스럽게, 손가락 살짝 굽힘. 다리 IK로 발은 제자리 고정. 고개·눈은 카메라, 미소 |
| `sit_default` | sit | `pelvis_seat_contact` | 좌판 위 골반 접촉, 허벅지 앞으로, 발은 IK로 바닥에, 손은 팔 IK로 허벅지 위, 치마는 허벅지 위로, 고개·눈은 카메라 |

`sit_default`의 좌판 높이 허용 범위는 0.30~0.60 m. 범위 밖이면 `SUPPORT_OUT_OF_RANGE` 오류.
좌판이 높아 발이 안 닿으면 허벅지를 최대 15°까지 내리고, 그래도 안 닿으면 발이 뜬 채로 렌더하고 `feet_on_floor=false`, 보고서 `foot_warning`으로 알린다.

### 프리셋 작업창 포즈 (VRM 렌더 전용)

원본은 PM님 프리셋 저장소 [micut-presets](https://github.com/MICUT-mikumikucamera/micut-presets)다. 이 저장소 옆 폴더에 클론해 두고, 프리셋이 바뀌면 다시 가져온다.

```powershell
git -C ..\micut-presets pull
node tools/import_presets.mjs            # poses/<ID>.json 갱신 + presets.lock.json
node tools/import_presets.mjs --check    # 쓰지 않고 비교만. 다르면 종료 코드 1
```

- `baked/poses.json`의 SHA-256을 그 저장소 `manifest.json`과 대조한다(Windows git의 CRLF 변환은 LF로 되돌려 계산). 저장소에서 빠진 프리셋은 `poses/`에서도 지운다. 우리 포즈(`stand_*`, `sit_default`)는 건드리지 않는다.
- `presets.lock.json`에 가져온 버전·커밋·파일 해시·포즈 목록이 남는다. 테스트가 `poses/`와 lock이 맞는지 본다.
- 지금 등록된 것: v0.6.5의 28개. 곡 포즈 `MV01`~`MV15`, 컬렉션 `COL_*` 12개, 추가 레퍼런스 `EX01`. `pose_id`는 조합 ID 그대로다.
- 기본 자세(`combo.base`)로 계약을 정한다. 서기 `B01`~`B04`와 점프 `B13`은 `action=stand`(점프 `MV12`는 발이 바닥에서 약 0.4 m 떠 있고 `pose_report.airborne=true`), 의자 `B05`~`B07`은 `action=sit`, `anchor_type=pelvis_seat_contact`. 쪼그리기·바닥 앉기(`B08`~`B12`)는 아직 계약이 없어 거부한다.
- v0.6.5에는 의자 기본 자세를 쓴 조합이 아직 없다. 앉는 조합은 `pose_ref`로 들어오거나 다음 버전에 추가되면 같은 규칙으로 렌더된다.

파일 `poses/<ID>.json`의 `baked`에는 작업창 엔진이 IK·양팔 협동·손가락·의상 보정까지 끝낸 최종 raw 뼈 변환, 작업창 루트 변환(몸 돌리기 `bodyYaw` 포함), 얼굴 morph가 들어 있다. VRM 렌더는 이 값을 그대로 얹고 발 중앙 아래 바닥점을 기준점으로 배치한다. 몸 돌리기는 배치 방향 기준으로 그대로 유지된다.

- **시선(2026-11-17)**: 작업창은 카메라(`source.gaze.point`, 작업창 좌표 [0, 1.3, 1.5] m)를 보도록 머리를 돌려 저장했다. 렌더 때 눈 사이에서 본 작업창 카메라 방향을 실제 사진 카메라 방향으로 옮기는 회전만큼 목(40%)·머리(60%)를 더 돌린다. PM님이 준 기울임과 카메라에서 살짝 비킨 각도는 그대로 남는다. 회전은 30°까지(`preset_look_limits.head_deg`), 눈은 머리 정면에서 12°까지 카메라를 본다. `gaze.target`이 `forward`인 `MV08`·`MV10`·`MV12`는 그대로 둔다. 손을 얼굴에 대거나 팔을 머리 옆으로 올린 포즈는 팔·손이 얼굴이나 앞머리에 원래 겹침(1 cm 미만이면 1 cm)보다 0.2 cm 넘게 더 들어가면 그만큼 덜 돌린다(`pose_report.look_at.reduced_for_hands`).
- **트윈테일**: 작업창은 트윈테일을 기본 자세 그대로 둔다(모든 조합이 같은 값). 렌더도 그 모양을 유지하고, 몸·팔·치마를 뚫는 부분만 아래 머리카락 정리로 밀어낸다.

- 같은 모델에서만 동작한다. 렌더 시 `miku.vrm`의 SHA-256이 다르면 `MODEL_MISMATCH`.
- Blender 경로는 이 포즈를 받지 않는다(오류).
- 원본 `status`·`notices`(관통 경고, 자동 보정 내용)는 `source`에 보존하고, manifest `pose_report.notices`로 넘긴다. 팔·다리 겹침은 고치지 않고 `penetration_body`로 보고만 한다.
- 확인: `examples/spatial.preset_front.json` + `examples/placement.preset_front.json`(작업창 미리보기와 비슷한 정면 카메라)으로 v0.6.0의 27개를 렌더해 PM님 미리보기와 나란히 비교했고, 모두 같은 자세로 보였다. v0.6.5에서 바뀌지 않은 조합은 가져온 관절값이 v0.6.0과 비트 단위로 같다.

**앉는 프리셋(의자 기본 자세)**: 작업창 의자 높이와 사진 좌판 높이가 다르므로 렌더 때 다리만 맞춘다. 골반 접촉점을 실제 좌판에 놓고, 상체·팔·발 방향은 그대로 둔다.

1. 정강이를 무릎에서 (다리 평면 안으로) 돌려 발바닥을 실제 바닥에 맞춘다. 좌판이 낮으면 발이 앞으로 나간다. 허벅지와 그 위에 얹은 손은 그대로다. 발을 좌판 밑으로 접어 넣지는 않는다.
2. 정강이를 세워도 모자라면(좌판이 높으면) 허벅지를 엉덩이에서 내린다. 원래보다 15°(`preset_max_thigh_drop_deg`)까지, 좌판면 아래로는 원래 깊이(1.5 cm 미만이면 1.5 cm)까지만.
3. 그래도 안 닿으면 발이 뜬 채로 두고 `pose_report.legs.<side>.feet_on_floor=false`. 키 1.58 m 캐릭터는 좌판이 0.5 m를 넘으면 실제로도 발이 뜬다.

- 발을 늘어뜨리는 높은 좌석(`B07`)은 발이 바닥을 뚫을 때만 올린다.
- 받는 좌판 높이(`support_height_m`): `B05`·`B06` 0.30~0.60 m, `B07` 0.55~0.90 m. 밖이면 `SUPPORT_OUT_OF_RANGE`.
- 보고: `pose_report.legs.<side>`의 `shin_turn_deg`, `thigh_drop_deg`, `moved_m`, `sole_gap_m`, `feet_on_floor`와 `pose_report.seat`(작업창 좌판 높이, 실제 좌판 높이).
- 확인: v0.6.5에 앉는 조합이 없어서, `sit_default`를 작업창 형식으로 뽑은 합성 샘플(`render_vrm.mjs --dump-pose 1`, 좌판 0.45 m)을 `pose_ref`로 0.38·0.45·0.52·0.60 m 좌판에 렌더했다. 0.45 m는 다리가 그대로, 0.38 m는 정강이가 36° 앞으로 펴져 발이 바닥에 닿고 손은 허벅지 위에 남았다. 0.52·0.60 m는 발이 각각 6.6·14.6 cm 떴다.

**`pose_ref`(작업창 엔진이 새로 만든 조합)**: 등록되지 않은 포즈는 `placement.json`에 `pose_ref`로 파일을 붙여 보낸다.

```json
{"pose_id": "gen_c0", "pose_ref": "poses_runtime/gen_c0.json", "action": "stand", "anchor_type": "feet_center_on_ground", "...": "..."}
```

- 파일 형식: 작업창 내보내기 항목 하나. `micut-presets`의 `baked/poses.json`에서 한 항목을 꺼낸 것과 같다(`raw_bone_transforms`, `root_transform`, `mesh_morphs`, `combo`, `status`, `notices`). 등록 프리셋과 같은 변환기(`web/preset_pose.js`)로 읽는다.
- 경로는 `placement.json`이 있는 폴더 기준 상대 경로이고, 그 폴더 밖이나 절대 경로는 거부한다. 8 MB까지.
- `pose_id`는 영문·숫자·`_.-` 64자 이하이고, 등록 포즈와 같은 ID는 거부한다.
- `action`·`anchor_type`은 파일의 기본 자세에서 정해지는 값과 같아야 한다.
- 거부 조건: 모델 SHA-256이 다르면 `MODEL_MISMATCH`, 형식이 틀리면 `INVALID_PLACEMENT`(`pose_ref:` 또는 `pose <id>:`로 시작하는 메시지). 형식이 틀린 경우는 쿼터니언이 단위가 아님, 값이 유한하지 않음, 뼈 중복, 모프 범위 밖, 지원하지 않는 기본 자세.
- manifest `pose_source`에 `{kind: "pose_ref", file, sha256, base}`를 남긴다. 등록 포즈는 `{kind: "registered", preset_version}`.
- Blender 경로(`contracts.py`)는 `pose_ref`와 `combo`를 거부한다.

**`combo`(배치가 고른 포즈 후보의 조합, 2026-11-23)**: 포즈 단계(MICUT-human `pose_candidates.json`)의 후보 `combo`가 `placement.json`에 같이 올 수 있다.

- 해시: `camera`·`reference`·`meta`를 뺀 combo를 키 정렬·공백 없는 JSON으로 만든 SHA-256(`tools/pose_ref.mjs`의 `comboSha256`). 포즈 단계는 combo에서 `camera`·`reference`만 빼고 `meta`에 `id`를 붙여 보내므로 셋을 뺀다.
- 등록 프리셋은 가져올 때 micut-presets `combos/<ID>.json`의 해시를 `source.combo_sha256`에 남긴다.
- `pose_ref`가 있으면 combo 해시를 기록만 한다(구운 파일이 기준).
- `pose_ref`가 없으면 `pose_id`가 등록 프리셋이고 combo 해시가 그 프리셋 해시와 같아야 한다. 아니면 `INVALID_PLACEMENT`("combo를 micut-presets `tools/combo-to-pose`로 구워 `pose_ref`로 보내 달라"). 예: 포즈 단계 예시의 v0.6.0 `COL_V`(기본 자세 `B01`)는 v0.6.5 등록 `COL_V`(`B02`)와 달라 거부된다.
- manifest `pose_source`에 등록 프리셋 해시(`combo_sha256`)와 받은 combo 판정(`placement_combo`)을 남긴다.

**`preserve`(보정해도 바뀌면 안 되는 부위, 2026-11-23)**: 후보의 `preserve: [{side: left|right|both, part, gesture}]`를 받아, 보정이 끝난 뒤 그 부위가 그대로인지 manifest·`result.json`의 `checks.preserve`에 남긴다.

- 부위 → 뼈: `fingers`(손가락), `hand`(손+손가락), `arm`·`coop`(팔 전체, `coop`은 양손 세트), `leg`·`legs`·`feet`(다리), `head`·`face`·`gaze`·`neck`(목·머리·눈).
- 비교: 작업창 관절값을 얹은 직후와 모든 보정(시선, 머리카락, 앉기 다리, 장면 물체) 뒤, 가슴 기준 상대 변환이 0.5° 와 2 mm 안이면 `pass`, 넘으면 `fail`(`max_turn_deg`, `max_move_m` 기록). 부위를 모르거나 작업창 포즈가 아니면(우리 포즈 `stand_*`·`sit_default`) `not_run`과 이유.
- 머리 계열 부위가 있으면 프리셋 시선 다시 맞추기를 하지 않는다(`look_at.mode = preset_as_authored`).
- 다리 계열 부위(`leg`·`legs`·`feet`·`foot`)가 있으면 앉는 프리셋의 다리 맞추기(정강이 돌리기·허벅지 내리기·의자 다리 피하기)를 그쪽 다리(`side`, `both`면 양쪽)에 하지 않는다. 다리는 작업창 그대로라 좌판 높이가 다르면 발이 뜨거나 바닥에 닿지 않을 수 있고, `pose_report.legs.<side>.kept_for_preserve=true`, `feet_on_floor`, `sole_gap_m`으로 보고한다(2026-11-23 결정).
- 지금 보정은 팔·손·손가락을 건드리지 않고, 다리는 지키라고 하면 맞추지 않으므로 이 부위들은 `pass`다(확인: 0.45 m 의자 자세를 0.54 m 좌판에 다리 preserve로 앉히면 다리 0.03°, 발 8.9 cm 뜸). `fail`이면 `result.json` 경고 `PRESERVE_FAILED`.
- 전체 `status`: 하나라도 `fail`이면 `fail`, 아니면 `pass`가 하나라도 있으면 `pass`, 아니면 `not_run`.

## Blender에서 직접 포즈 잡기

손으로 잡은 포즈를 `poses/<pose_id>.json`으로 바꾸는 도구가 `tools/export_pose.py`다.

1. 모델 `.blend`의 **복사본**을 `local/pose_work/`에 만들어 연다. 원본은 덮어쓰지 않는다.
2. Armature 선택 → Pose Mode → 뼈를 회전(`R`)한다. 위치 이동은 골반 루트(`Waist`)만 반영된다.
   연결된 뼈의 이동은 Blender가 무시하므로 내보내지 않고 `ignored_connected_bone_moves`로 알린다.
3. 표정은 메시 → Object Data → Shape Keys 값을 바꾼다.
4. 저장한 뒤 실행한다.

```powershell
.\scripts\export_pose.ps1 -PosedBlend local\pose_work\peace.blend -PoseId stand_peace `
  -Base poses\stand_natural.json -Description '브이 포즈'
```

- 바꾼 뼈만 기록한 뒤, 기본 자세로 되돌려 **렌더러와 같은 코드로 다시 적용**해 보고 원래 포즈와 비교한다. 0.05° / 0.5 mm 넘게 다르면 저장하지 않고 실패한다.
- 회전은 기본 자세 대비 캐릭터 기준(`[오른쪽, 위, 앞]`) 회전(`orient`)으로, 뼈 이름은 프로필의 휴머노이드·손가락 키(`left_upper_arm`, `left_index_1` 등)로 저장한다. 그래서 기본 자세가 비슷한 다른 모델에도 옮길 수 있다. 프로필에 없는 뼈(소매 등)는 원래 이름으로 저장하고 `model_specific: true`로 표시한다.
- `-Base`로 준 포즈에서 `action`, IK 모드, 시선 설정을 물려받는다. 이 설정이 켜져 있으면 해당 부위는 렌더 때 다시 계산되며, 결과 JSON의 `source.overridden_at_render`에 적힌다.
  예: `stand_natural`을 베이스로 쓰면 다리(발 고정 IK)와 고개·눈(카메라 시선)은 손으로 잡은 값 대신 렌더 때 다시 정해진다. 손으로 잡은 고개 각도를 살리려면 결과 JSON에서 `look_at`을 지운다.
- 서기에서 골반을 위로 올리면 다리가 바닥까지 닿지 않아 `reached=false`가 된다. 이때도 발바닥 기준점은 실제 발 위치로 다시 잡으므로 공중에 뜨지는 않는다.
- 새 포즈는 `examples/testset.json`에 케이스를 추가해 비교 시트로 확인한다.

## 착석 입력 (성윤님 SEATING_PREP 제안 그대로)

```json
{
  "coordinate_frame": "geometry_world",
  "unit": "m",
  "action": "sit",
  "pose_id": "sit_default",
  "anchor_type": "pelvis_seat_contact",
  "anchor_position": [0.874, 0.445, 1.481],
  "facing_rule": "world_direction",
  "facing_direction": [0.0, 0.0, -1.0],
  "support_candidate_id": 2
}
```

- `anchor_position`: 좌판 위 골반(좌골) 접촉 중심. Y = 좌판 높이.
- 골반 접촉점은 렌더 쪽에서 메시로 계산한다: 엉덩이·허벅지 위쪽 vertex group 중 고관절 기준 뒤 14 cm~앞 5 cm 범위의 가장 낮은 면.
- `support_candidate_id`는 그대로 manifest에 기록만 한다.
- `selection`(선택): 배치 쪽 선택 방식(`rule` / `jev` / `manual`). 렌더는 해석하지 않고 manifest → `result.json`으로 넘긴다. 서기·앉기 모두 받는다.

## manifest에 추가된 항목

| 항목 | 내용 |
|---|---|
| `local_frame` | 로컬 좌표 정의. **x = 캐릭터 오른쪽(r=[f_z,0,-f_x]), y = 위, z = 바라보는 방향, 원점 = anchor.** 성윤님 `micut_place.shape`와 같은 축 |
| `contacts` | anchor(서기는 양발 중앙, 앉기는 골반 접촉), 양발 바닥점(world·local)과 바닥과의 틈 |
| `support` | `floor` 또는 `seat`, 높이, `support_candidate_id` |
| `body_collision_proxy` | 몸 충돌 캡슐 14개(몸통, 머리, 팔·손, 다리·발). 머리카락·치마·소매 제외. 반지름 = 해당 부위 정점 거리의 85% 값 |
| `pose_report` | IK 결과: 다리·팔 도달 여부와 오차, 허벅지 각도, 발 바닥 접촉, 시선 잔여각, 표정, 정리된 머리카락·치마 뼈 수 |
| `pose_source` | VRM 경로만. 등록 포즈(`registered`, 프리셋 버전) 또는 `pose_ref`(파일 경로·SHA-256·기본 자세) |
| `penetration_below_support` | 바닥(앉기는 좌판 포함) 아래로 들어간 정점 수를 머리카락/치마/몸으로 나눔 |
| `penetration_scene` | VRM 경로. 사진 물체(의자 등받이·좌판·다리 등)를 뚫은 정점 수(머리카락/앞머리/치마/몸), 최대 깊이, 물체 id별 수, `status`(50개 이상 `fail`). 기하에 `depth.npy`·`depth_validity.png`·`masks.png`가 없거나 `--scene off`면 `{status: "not_run", reason}`. 판정은 아래 "장면 물체" |
| `checks` | VRM 경로. `preserve`(위 "preserve")와 `penetration_scene`(상태·이유). `result.json`의 `quality.checks`로도 나간다 |
| `penetration_body` | VRM 경로만. 몸끼리 1 cm 넘게 겹친 정점 수·최대 깊이·부위: 트윈테일↔몸·치마·팔(`hair`), 팔뚝·손↔몸·치마·반대 팔(`left_arm`·`right_arm`), 팔·손↔얼굴·앞머리(`arms_head`), 왼 정강이·발↔오른 다리(`legs`). 판정: 가장 가까운 상대 정점(4 cm 안)의 법선 안쪽 |

`render_stand.py --export-shape`를 주면 `shape.npz`(성윤님 `export_stand_shape.py`와 같은 형식)를 같이 쓴다. 포즈 무관하게 깊이 합성에 쓸 수 있다.

실패 시 `error.json`에 `code`가 추가됨: `INVALID_PLACEMENT`, `SUPPORT_OUT_OF_RANGE`, `MODEL_MISMATCH`, `RENDER_FAILED`.

## 실행

```powershell
$env:BLENDER_BIN = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
uv run --no-project --with numpy --with pillow --with OpenEXR python tools/run_testset.py `
  --placement-repo ..\MICUT-placement-decision --out outputs/testset
```

`examples/testset.json`의 8개 케이스를 렌더하고 sample1 케이스는 깊이 합성까지 한다. 결과는 `outputs/testset/sheet.png`, `summary.json`.
`--debug-supports`가 켜진 케이스(가상 카메라)는 회색 바닥·좌판을 같이 렌더한다. 사진 합성에는 쓰지 않는다.
측면(`spatial.side.json`)·근접(`spatial.close.json`) 가상 카메라는 포즈 확인용이다.

## 사진 합성 (`final.jpg`, `result.json`)

데모는 IK·렌더 쪽이 최종 사진까지 만든다(2026-11-04 확정). 두 단계다.

```powershell
# 1) 렌더: --photo를 주면 사진 기반 조명, 그림자 받이 면, passes.exr(선형 색·깊이·그림자)이 켜진다
& $env:BLENDER_BIN --background local\models\<model>.blend --disable-autoexec --python-exit-code 1 `
  --python tools\render_stand.py -- --spatial local\geometry\sample1\spatial_info.json `
  --placement examples\placement.sample1.stand.json --out outputs\case --export-shape `
  --photo local\geometry\sample1\image.jpg --render-scale 1
# 2) 합성: final.jpg + result.json + debug/
uv run --no-project --with numpy --with pillow --with OpenEXR python tools\finalize.py `
  --render-dir outputs\case --geometry-dir local\geometry\sample1 --out outputs\results\case\1 `
  --placement-repo ..\MICUT-placement-decision
```

- **조명**: 사진 자체로 주변 조명을 만든다. 카메라가 본 방향은 흐린 사진 색, 못 본 방향은 사진 위쪽 띠(천장, ×1.3)·아래쪽 띠(바닥)·전체 평균. `--exposure`(기본 2)는 사진 픽셀에 섞인 물체 반사율(약 0.5)을 보정한다. 광원 방향은 따로 추정하지 않는다.
- **그림자**: 바닥(좌석이면 좌판 위도)에 그림자만 받는 투명 면을 깐다. 반지름 1.5 m 정사각형이며 가장자리에서 서서히 사라지게 한다. 사진 깊이로 그 면이 실제로 보이는 곳에만 그림자를 얹는다(테이블 받침 등 앞에 있는 물체 위에는 안 얹음).
- **가림**: 성윤님 `micut_place.compose`와 같은 규칙(사진 깊이가 미쿠보다 3 cm 넘게 가까우면 가림)을 쓰되, 미쿠 깊이는 렌더의 깊이 패스에서 가져온다. 그래서 렌더 배율과 상관없이 동작한다. `--placement-repo`를 주면 1배율에서 `micut_place.compose`를 같이 돌려 두 마스크가 얼마나 겹치는지(IoU)를 `result.json`에 남긴다.
- **해상도**: `--render-scale N`은 같은 렌즈로 화소만 N배 늘려 렌더한다. 원본 사진은 `finalize.py --photo`로 준다. 없으면 768×1024 사진을 키워 쓰고 `BACKGROUND_UPSCALED` 경고를 남긴다. 깊이는 확대해서 비교한다.
- **기하 출력 geometry.v5 (2026-11-19 확인, `sample1`·`manychairs`)**: 예전 형식에 필드만 더해진 상위 호환이라 카메라·좌표·깊이는 그대로 읽는다. 새 필드 중 렌더·합성이 쓰는 것:
  - `coordinate_contract`: 있으면 `geometry_world`·`m`·`[right, up, forward]`·`left`, `image_size` = 이미지 크기인지 확인하고, 아니면 `INVALID_GEOMETRY`(VRM·Blender 경로 같음).
  - `depth_validity.png`: 기하 단계가 무효로 표시한 깊이 화소(물체 경계에서 튀는 점, 바닥 아래 반사)는 가림 판정에 쓰지 않고 이웃 유효 값으로 채운다. 두 장면 6개 배치에서 바뀐 화소는 의자·테이블 경계 1화소 선(장면당 44~296화소)뿐이었다. `result.json`의 `quality.depth_valid_ratio`에 유효 비율을 남긴다. 파일이 없는 예전 기하는 `DEPTH_VALIDITY_MISSING` 경고.
  - `image.original_size`(·`camera_source.crop_xywh`): `render_vrm.mjs --render-scale original`이 원본 사진 해상도 배율을 계산한다(sample1 5.578125). 기하가 원본을 잘랐으면 `finalize.py`가 원본 사진을 같은 영역으로 자른다.
  - `depth.calibrated=false`(실측 기준 없이 AI 깊이 그대로, 예: `manychairs`): `DEPTH_UNCALIBRATED` 경고. 장면 크기가 틀릴 수 있어 1.58 m 미쿠와 의자 높이가 안 맞을 수 있다.
  - `surfaces`·`inferred_surfaces`·`obstacles`·`observation`은 배치용이라 렌더는 읽지 않는다.
- **출력**: [OUTPUT_CONTRACT.md](OUTPUT_CONTRACT.md) 초안의 결과 폴더 형식. 실패 기준은 아직 없어서 품질 문제는 `quality.warnings`로만 남기고 `status`는 `done`.

## 한계와 다음 작업

- 머리카락·치마는 물리 없이 뼈 단위로만 정리한다. 메시 두께 때문에 일부 정점이 지지면 아래로 들어갈 수 있고, 그 수는 `penetration_below_support`로 보고한다.
- **장면 물체(2026-11-19, VRM 경로)**: IK는 의자를 좌판 높이 평면으로만 받으므로 등받이·다리를 모른다. 기하 출력에 깊이·유효 마스크·물체 마스크(`depth.npy`, `depth_validity.png`, `masks.png`)가 있으면 렌더가 읽어 사진 물체를 장애물로 쓴다(`--scene off`로 끔).
  - 판정: 카메라에서 보이는 물체 표면 뒤로 1 cm 넘게, 그 물체 두께 안에 있으면 "물체 안". 두께는 앉은 의자(`support_candidate_id`의 물체) 0.30 m, 다른 물체 0.06 m(맞닿는 범위). 그보다 뒤는 정상적인 가림이다. 바닥 라벨과 높이 5 cm 이하는 빼고, 깊이가 무효인 화소는 판단하지 않는다.
  - 머리카락: 몸·지지면 정리 뒤에 한 번 더 돈다. 자기 정점이 물체 안에 들어간 트윈테일 뼈만(머리 쪽부터) 그 마디에서 꺾어, 꼬리가 물체에 닿는 지점부터 아래만 움직인다. 뿌리에서 통째로 돌리면 꼬리가 옆으로 뻗거나 등 뒤로 숨었다(gensit18 왼쪽 꼬리). 각 뼈는 몸 앞뒤 축·위 축·오른쪽 축으로 ±5~50°를 시험해, 그 아래 머리카락 정점의 겹침(물체·몸·지지면 합)을 90% 이상 없애는 가장 작은 회전을 고른다. 몸 중심선 쪽으로 접어 넣는 회전은 90° 더 큰 것으로 쳐서 뒤로 미룬다. 결과는 `pose_report.hair_scene_clear`(돌린 뼈·축·각도 `turns_log`, 처음 닿은 물체 `scene_objects_before`).
  - 앉는 프리셋의 정강이·발이 의자 다리나 좌판 앞을 뚫으면 무릎에서 앞으로 3~30° 편다(바닥 아래로는 안 내림). 결과는 `pose_report.legs.<side>.scene_shin_turn_deg`.
  - 확인(manychairs): 의자 19·18에 앉힌 두 배치에서 등받이를 4~16 cm 뚫던 트윈테일(합성에서 잘려 보이던 부분)이 0으로, 18번 의자 다리를 지나던 정강이 겹침이 0.86 m→0.09 m(정점별 깊이 합)로 줄었다. 허벅지 아랫면이 좌판·소파 쿠션에 묻히는 것(7~8.5 cm, 정면에서는 안 보임)은 보고만 한다. `finalize.py`는 장면 관통 정점이 50개 이상이면 `SCENE_PENETRATION` 경고를 남긴다(몇 개는 깊이 잡음).
  - `stand_default`의 기준 수치(`docs/validation/stand_model_manifest.json`)는 아무것에도 닿지 않는 배치 기준이다. 물체에 닿는 배치에서는 트윈테일이 움직여 경계가 달라질 수 있다(예: sample1 테이블 앞에서 꼬리 끝이 모서리를 피해 조금 벌어짐).
- VRM 경로는 트윈테일 뼈를 뿌리부터 끝까지 보며, 자기 정점이 몸·팔·치마 안(6 cm 안의 가장 가까운 정점 법선 기준)이나 지지면 아래에 있으면 가장 깊은 정점이 빠져나올 만큼만 그 뼈를 돌린다(한 번에 30° 이하, 4회). 중력으로 늘어뜨리지 않는다. 서 있는 포즈, 앉은 포즈, 프리셋 모두 같다. Blender 경로(`posing.py`)에는 아직 없다.
- three-vrm은 스프링본(트윈테일, 넥타이)의 `matrixAutoUpdate`를 꺼 둔다. 렌더는 물리를 돌리지 않으므로 로드 직후 다시 켠다. 켜기 전에는 이 뼈들에 준 회전이 무시돼 `sit_default`의 머리카락이 좌판 밑으로 6 cm 들어갔다.
- 착석은 좌판 앞 가장자리 위치를 모른다. 허벅지를 내리면 좌판 안쪽에서 허벅지 아랫면이 몇 mm~1 cm 들어갈 수 있다. 앞 가장자리를 입력으로 받으면 허벅지가 가장자리 너머에서만 내려가게 바꿀 수 있다.
- 손가락은 같은 각도로 일괄 굽힘. 손 제스처(브이, 손 흔들기)는 다음 포즈로 추가.
- 등받이·팔걸이 기대기(접촉점 여러 개)는 v2.
- 사진 없이 렌더하는 가상 카메라 케이스는 여전히 고정 스튜디오 조명.
- 사진 기반 조명은 방향성이 약해 그림자가 부드럽고 옅다. 창문·조명 위치 추정은 아직 없다.
