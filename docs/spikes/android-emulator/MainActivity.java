package dev.copse.androidspike;
import android.app.Activity;
import android.os.Bundle;
import android.widget.*;
public class MainActivity extends Activity {
  int taps=0;
  public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout layout=new LinearLayout(this); layout.setOrientation(1); layout.setPadding(32,48,32,32);
    TextView title=new TextView(this); title.setText("Copse Android spike"); title.setTextSize(26); layout.addView(title);
    TextView count=new TextView(this); count.setText("Taps: 0"); count.setTextSize(24); layout.addView(count);
    Button button=new Button(this); button.setText("Tap me"); button.setOnClickListener(v -> { count.setText("Taps: "+(++taps)); android.util.Log.i("CopseSpike","tap="+taps); }); layout.addView(button);
    EditText edit=new EditText(this); edit.setHint("Type here"); edit.setSingleLine(true); layout.addView(edit);
    setContentView(layout);
    android.util.Log.i("CopseSpike","created");
  }
}
