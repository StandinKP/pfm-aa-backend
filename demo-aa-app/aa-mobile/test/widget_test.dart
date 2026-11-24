import 'package:flutter_test/flutter_test.dart';

import 'package:aa_mobile/main.dart';

void main() {
  testWidgets('splash screen shows the get-started button', (WidgetTester tester) async {
    await tester.pumpWidget(const AaDemoApp());
    expect(find.text('Get started'), findsOneWidget);
  });
}
