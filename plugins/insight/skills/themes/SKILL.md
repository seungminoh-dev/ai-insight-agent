---
name: themes
description: Insight에 쌓인 나의 평소 가치관(반복되는 원칙)을 많이 나온 순으로 보여 준다. "내 평소 가치관 뭐야", "자주 하는 생각 보여줘"라고 하거나 /insight:themes로 쓴다. 인자로 말을 주면 그 말이 들어간 테마만 찾는다.
argument-hint: "[찾을 말]"
---

# 평소 가치관 보기

Insight MCP 서버의 `find_themes` 도구를 쓴다 (도구 이름이 그렇게 끝난다). 도구가 보이지 않으면 "설정 → 커넥터에서 Insight(https://insight.smoh.dev/mcp)를 연결해 주세요"라고 알리고 멈춘다.

1. `find_themes`를 부른다. 인자가 있으면($ARGUMENTS) `query`로 넘긴다.
2. 많이 나온 순으로 보여 준다: `<횟수>번 · <테마 문장>`. 최근 30일 안에 나온 것은 표시한다.
3. 결과가 많으면 상위 10개만 보여 주고, 나머지 개수와 대시보드(https://insight.smoh.dev "평소 가치관" 탭)를 알려 준다.
4. 해석을 덧붙이지 않는다. 사용자가 물으면 그때 테마끼리의 관계나 변화를 이야기한다.
