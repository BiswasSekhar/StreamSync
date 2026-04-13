import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
} from "react-native";

interface Props {
  navigation: any;
  route: { params?: { url?: string } };
}

export function JoinScreen({ navigation, route }: Props) {
  const [url, setUrl] = useState(route.params?.url || "");

  useEffect(() => {
    // Handle deep links
    const handleUrl = ({ url: deepUrl }: { url: string }) => {
      if (deepUrl) setUrl(deepUrl);
    };

    const subscription = Linking.addEventListener("url", handleUrl);

    Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl) setUrl(initialUrl);
    });

    return () => subscription?.remove();
  }, []);

  const handleJoin = () => {
    if (!url.trim()) {
      Alert.alert("Enter URL", "Please paste the StreamSync room link");
      return;
    }

    try {
      new URL(url.trim());
    } catch {
      Alert.alert("Invalid URL", "Please enter a valid room link");
      return;
    }

    navigation.navigate("Session", { roomUrl: url.trim() });
  };

  return (
    <View style={styles.container}>
      <View style={styles.logo}>
        <View style={styles.logoIcon}>
          <Text style={styles.logoIconText}>▶</Text>
        </View>
        <Text style={styles.logoText}>StreamSync</Text>
        <Text style={styles.logoSubtext}>P2P Watch Party</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Room Link</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="Enter the room link shared by the host"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          multiline
        />
        <TouchableOpacity style={styles.button} onPress={handleJoin}>
          <Text style={styles.buttonText}>Join Watch Party →</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>
          Get the link from the host's StreamSync app
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f0f0f",
    justifyContent: "center",
    padding: 24,
  },
  logo: {
    alignItems: "center",
    marginBottom: 48,
  },
  logoIcon: {
    width: 64,
    height: 64,
    backgroundColor: "#6366f1",
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  logoIconText: { color: "white", fontSize: 24 },
  logoText: {
    color: "#f0f0f0",
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  logoSubtext: { color: "#9ca3af", fontSize: 14, marginTop: 4 },
  card: {
    backgroundColor: "#1a1a1a",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#2a2a2a",
  },
  label: { color: "#9ca3af", fontSize: 12, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    backgroundColor: "#2a2a2a",
    borderRadius: 10,
    padding: 14,
    color: "#f0f0f0",
    fontSize: 13,
    fontFamily: "monospace",
    minHeight: 60,
    borderWidth: 1,
    borderColor: "#3a3a3a",
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#6366f1",
    borderRadius: 10,
    padding: 16,
    alignItems: "center",
    marginBottom: 12,
  },
  buttonText: { color: "white", fontSize: 15, fontWeight: "600" },
  hint: { color: "#666", fontSize: 12, textAlign: "center" },
});
