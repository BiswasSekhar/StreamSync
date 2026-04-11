import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { JoinScreen } from "./screens/JoinScreen";
import { SessionScreen } from "./screens/SessionScreen";

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          primary: "#6366f1",
          background: "#0f0f0f",
          card: "#1a1a1a",
          text: "#f0f0f0",
          border: "#2a2a2a",
          notification: "#6366f1",
        },
      }}
    >
      <Stack.Navigator
        initialRouteName="Join"
        screenOptions={{
          headerStyle: { backgroundColor: "#1a1a1a" },
          headerTintColor: "#f0f0f0",
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen
          name="Join"
          component={JoinScreen}
          options={{ title: "StreamSync", headerShown: false }}
        />
        <Stack.Screen
          name="Session"
          component={SessionScreen}
          options={{ title: "Watch Party", headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
