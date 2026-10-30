# 실파일 검증 결과

## 실행 환경

- Blender 5.2.0 LTS, Cycles CPU
- 순수 Python 계약 테스트: 12개 통과
- Blender 카메라 투영 테스트: 3가지 이미지 크기·fx/fy·주점 조합 통과
- 석훈님 원본 spatial_info.json 카메라 투영 비교 통과
- 투영 비교의 최대 오차: 약 0.000551px, 허용 기준 0.01px
- PowerShell 실행 스크립트 inspect-only 동작 확인

단위 테스트와 투영 일치는 연결 구현 검사이며 Depth 모델의 절대 거리 정확도를 입증하지 않음.

## 원본 파일 검사

### 처음 제공된 VRM (Cube 파일)

- 파일명: `3000533088641481097.vrm`
- 파일 크기: 17,576바이트
- 메시: `Cube` 1개, POSITION accessor 24개 정점
- 이미지: 0개
- 휴머노이드 뼈 매핑: 있음
- 미쿠 외형 메시: 없음

따라서 이 VRM의 2단위 Cube 크기를 캐릭터 키로 쓰면 안 됨. 메타데이터에는 OnlyAuthor, Redistribution_Prohibited 등의 표기가 있음. 파일 출처·정상 export·공유 조건 확인 필요. 이 파일을 자동 변환해서 최종 미쿠 VRM으로 간주하는 처리는 하지 않음.

### 제공 Blender 파일

- 파일명: `legend_pretty_miku_look.blend`
- 실캐릭터 메시: 22,530개 정점, 37,459개 폴리곤
- Armature modifier와 vertex group 존재
- packed texture 존재, 실제 렌더로 외형 확인
- 원본은 수정하지 않았으며 렌더 전 manifest SHA와 렌더 후 파일 SHA 일치 확인

## 기본 서기 렌더

합성 카메라임을 명시한 `spatial.synthetic.json`과 anchor `[0,0,3.2]` 사용.

- 목표 키 1.58m 적용 후 전체 외형이 화면 안에 포함
- 가로 0.64521744m, 높이 1.58m, 앞뒤 0.51944977m
- 발바닥 중점 오차 0.0001m 미만 통과
- 양발 바닥 높이 차이 약 0.000000068m
- 768×1024 RGBA PNG 생성 확인
- 테스트 장면은 출력 폴더의 `placed_scene.blend`에 별도 저장

1.58m는 검증용 설정이며 최종 디자인 크기 확정이 아님. 전체 외형 크기는 머리카락·의상 포함. 몸체 충돌 프록시는 미구현.

## 실제 기하 카메라 연결

석훈님 `spatial_info.json`과 성윤님 JSON 형식의 예시 위치 `[0.3,0,0.8]` 사용.

- 동일한 1.58m 배율 유지
- 발바닥 중점 `[0.300000012, 0.000000034, 0.800000012]`
- 투영 경계의 오른쪽 끝 약 812.38px, 사진 가로 768px를 벗어남
- `rendered_with_framing_warning` 반환, 자동 축소·위치 변경 없음
- 이 위치는 연결 테스트 예시이며 최종 후보 선택·충돌 검사로 승인한 배치가 아님
- `flat_preview.png`는 원본 사진 위 단순 합성 결과. 테이블 가림·그림자·충돌을 해결한 최종 합성이 아님

기하 파일의 카메라 파라미터·스케일은 원본 결과를 그대로 이용함. 실측 보정의 정확성을 별도 검증하지 않았으며 기존의 대략적인 기준값 사용 한계가 남아 있음.

## 저장소에 남긴 수치 자료

- `validation/stand_model_manifest.json`: 실제 모델 정규화·발바닥·크기
- `validation/stand_placement_report.json`: 전체 화면에 들어오는 synthetic 예시 결과
- `validation/geometry_example_report.json`: 실제 기하 카메라·화면 잘림 결과
- `validation/vrm_file_inspection.json`: 제공 VRM 검사

원본 모델·사진·파생 모델·렌더 PNG는 Git 제외. 로컬 `outputs/`에서 확인 가능.

## 다음 검증

성윤님이 계산한 실제 후보 위치로 재실행, 모델 바뀔 때 manifest 갱신, 비평면 발 접촉 IK, 앉기, 공간 충돌, 깊이 가림, 조명·그림자 순으로 검증 필요.

## 새 VRM 직접 렌더 검증

- 파일: `3000533088641481097 (1).vrm`, 30,918,696바이트, VRM 1.0
- 실제 캐릭터 POSITION 정점 22,530개, 이미지 6개, 휴머노이드 매핑 51개
- three.js 0.186.1 + @pixiv/three-vrm 3.5.5, 로컬 headless Chrome WebGL
- Blender를 호출하지 않고 VRM 로딩·고정 서기·발 기준점·배율·렌더 확인
- 1.58m 설정 시 가로 0.645217468m, 앞뒤 0.519449795m. Blender 크기와 0.000001m 이내 일치
- synthetic 카메라 전체 화면 포함. 실제 기하 예시 위치는 Blender와 마찬가지로 오른쪽 화면 잘림 경고
- 실제 기하 카메라 투영 비교 오차 약 0.000104px
- 브라우저 오류 없음. JavaScript 입력·투영 테스트 5개 통과
- 모델은 Git 제외. `validation/vrm_direct_report.json`과 `validation/vrm_new_file_inspection.json`에 수치 기록

같은 외형 크기와 배치 투영 검증이며 재질·조명까지 두 렌더러가 동일하다는 의미는 아님. 접촉 IK·가림·충돌은 여전히 후속 작업.
