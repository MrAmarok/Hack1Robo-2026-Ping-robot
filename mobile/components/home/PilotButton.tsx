import { Text, TouchableOpacity, type TouchableOpacityProps } from 'react-native';
import { pilotStyles as styles } from './pilotStyles';

type Props = TouchableOpacityProps & {
  label: string;
  active?: boolean;
  emergency?: boolean;
  warning?: boolean;
  symbol?: boolean;
};

export function PilotButton({ label, active, emergency, warning, symbol, style, disabled, ...props }: Props) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      {...props}
      disabled={disabled}
      style={[
        styles.button,
        active && styles.buttonActive,
        warning && styles.buttonWarning,
        emergency && styles.buttonEmergency,
        symbol && styles.drive,
        disabled && styles.buttonDisabled,
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, emergency && styles.emergencyLabel, symbol && styles.symbol]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}
